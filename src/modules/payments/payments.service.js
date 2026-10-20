const prisma = require('../../config/db');
const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');
const { assertWithinLimits } = require('../wallet/limits.guard');
const { getMerchantFeeRate } = require('../../config/fees');
const { generateApiKey } = require('./apiKey.util');
const businessPaymentFields = require('./businessPaymentFields.service');
const { parsePagination, buildPaginatedResult } = require('../../utils/pagination');
const { notifyUser } = require('../notifications/notification.service');
const { encrypt } = require('../../utils/encryption');

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Coeur commun aux deux entrées (paiement in-app ET API B2B) : un
// utilisateur (ou le client d'un partenaire) paie un compte Business.
// Deux mouvements de fonds successifs et distincts :
//   1) payeur -> wallet du marchand, pour le montant total
//   2) wallet du marchand -> FEES_COLLECTED, pour la commission
// Séparer les deux garde chaque Transaction simple à lire dans
// l'historique - un paiement de 100 000 GNF avec 1 500 GNF de frais
// apparaît comme deux lignes claires, pas un seul mouvement confus.
async function payBusiness({ payerUserId, businessUserId, amount, idempotencyKey, metadata, customFields }) {
  const business = await prisma.user.findUnique({
    where: { id: businessUserId },
    include: { businessProfile: true },
  });

  if (!business || !['BUSINESS', 'MERCHANT'].includes(business.accountType)) {
    throw new PaymentError('Destinataire non reconnu comme compte Business ou Marchand', 404);
  }
  if (business.businessProfile?.reviewStatus !== 'APPROVED') {
    throw new PaymentError("Ce compte Business n'est pas encore validé", 403);
  }

  // Uniquement pour le flux de paiement in-app (customFields fourni) - le
  // flux API partenaire (voir paymentIntent.service.js) n'a pas encore
  // d'équivalent pour les champs personnalisés, c'est une limite connue.
  // Les libellés sont figés dans les métadonnées AU MOMENT du paiement :
  // si l'institution renomme ou supprime un champ ensuite, le reçu déjà
  // émis reste inchangé et fidèle à ce qui a réellement été demandé.
  let enrichedMetadata = metadata;
  if (customFields) {
    const fieldDefs = await businessPaymentFields.assertCustomFieldsComplete(businessUserId, customFields);
    enrichedMetadata = {
      ...metadata,
      customFields: fieldDefs.map((f) => ({
        label: f.label,
        fieldKey: f.fieldKey,
        value: customFields[f.fieldKey] || null,
      })),
    };
  }

  await assertWithinLimits(payerUserId, amount);

  const payerWallet = await walletService.getOrCreateUserWallet(payerUserId);
  const businessWallet = await walletService.getOrCreateUserWallet(businessUserId);

  // Vérifié AVANT moveFunds (idempotent pour l'argent) : sans ce contrôle,
  // un retry réseau d'un paiement déjà traité renotifierait payeur et
  // marchand en double pour un évènement déjà survenu.
  const alreadyProcessed = await prisma.transaction.findUnique({ where: { idempotencyKey } });

  const payment = await walletService.moveFunds({
    fromWalletId: payerWallet.id,
    toWalletId: businessWallet.id,
    amount,
    type: 'MERCHANT_PAYMENT',
    idempotencyKey,
    initiatedByUserId: payerUserId,
    metadata: enrichedMetadata,
  });

  const feeRate = getMerchantFeeRate(business.businessProfile);
  const feeAmount = Math.round(Number(amount) * feeRate);

  let feeTransaction = null;
  if (feeAmount > 0) {
    const feesWallet = await walletService.getOrCreateSystemWallet('FEES_COLLECTED');
    feeTransaction = await walletService.moveFunds({
      fromWalletId: businessWallet.id,
      toWalletId: feesWallet.id,
      amount: feeAmount,
      type: 'FEE',
      idempotencyKey: `${idempotencyKey}:fee`,
      initiatedByUserId: payerUserId,
      metadata: { relatedTransactionId: payment.id, feeRate },
    });
  }

  if (!alreadyProcessed) {
    const businessName = business.businessProfile.businessName;
    const amountLabel = Number(amount).toLocaleString('fr-FR');

    await notifyUser(payerUserId, {
      type: 'PAYMENT_SENT',
      title: 'Paiement effectué',
      body: `Paiement de ${amountLabel} GNF à ${businessName}`,
      data: { transactionId: payment.id },
    });

    const payer = await prisma.user.findUnique({ where: { id: payerUserId } });
    await notifyUser(businessUserId, {
      type: 'PAYMENT_RECEIVED',
      title: 'Paiement reçu',
      body: `Paiement de ${amountLabel} GNF reçu de ${payer?.fullName || payer?.phone || 'un client'}`,
      data: { transactionId: payment.id },
    }, `FlexPay : vous avez reçu un paiement de ${amountLabel} GNF.`);
  }

  return { payment, feeAmount, feeRate, feeTransaction };
}

// Variante "invité" de payBusiness : le payeur n'a pas de compte FlexPay
// (il paie via Mobile Money - Orange Money, MTN - depuis un lien de
// paiement public, voir paymentLinks.service.js). Mêmes commission et
// plafond de solde marchand, mais l'argent vient d'un wallet système
// (EXTERNAL_MOBILE_MONEY, déjà utilisé par wallet.service.deposit) plutôt
// que du wallet d'un payeur - donc ni payerWallet, ni assertWithinLimits
// (ce plafond protège le COMPTE du payeur, qui n'existe pas ici), ni OTP
// (aucune session à protéger). La confirmation de paiement elle-même est
// déjà obtenue par l'appelant via mobileMoney.service.collect() avant
// d'appeler cette fonction.
async function payBusinessGuest({ businessUserId, amount, payerPhone, idempotencyKey, metadata, customFields }) {
  const business = await prisma.user.findUnique({
    where: { id: businessUserId },
    include: { businessProfile: true },
  });

  if (!business || !['BUSINESS', 'MERCHANT'].includes(business.accountType)) {
    throw new PaymentError('Destinataire non reconnu comme compte Business ou Marchand', 404);
  }
  if (business.businessProfile?.reviewStatus !== 'APPROVED') {
    throw new PaymentError("Ce compte Business n'est pas encore validé", 403);
  }

  // Contrairement à payBusiness (qui ne valide que si l'appelant fournit
  // customFields, pour rester compatible avec le flux API partenaire sans
  // équivalent), ici la validation est TOUJOURS appliquée : un payeur
  // anonyme qui appelle cette route publique sans passer par l'app ne doit
  // jamais pouvoir contourner un champ marqué obligatoire par l'institution.
  const fieldDefs = await businessPaymentFields.assertCustomFieldsComplete(businessUserId, customFields || {});
  let enrichedMetadata = { ...metadata, payerPhone };
  if (fieldDefs.length > 0) {
    enrichedMetadata = {
      ...enrichedMetadata,
      customFields: fieldDefs.map((f) => ({
        label: f.label,
        fieldKey: f.fieldKey,
        value: customFields?.[f.fieldKey] || null,
      })),
    };
  }

  const sourceWallet = await walletService.getOrCreateSystemWallet('EXTERNAL_MOBILE_MONEY');
  const businessWallet = await walletService.getOrCreateUserWallet(businessUserId);

  const alreadyProcessed = await prisma.transaction.findUnique({ where: { idempotencyKey } });

  const payment = await walletService.moveFunds({
    fromWalletId: sourceWallet.id,
    toWalletId: businessWallet.id,
    amount,
    type: 'MERCHANT_PAYMENT',
    idempotencyKey,
    initiatedByUserId: null, // pas de compte FlexPay côté payeur
    metadata: enrichedMetadata,
  });

  const feeRate = getMerchantFeeRate(business.businessProfile);
  const feeAmount = Math.round(Number(amount) * feeRate);

  let feeTransaction = null;
  if (feeAmount > 0) {
    const feesWallet = await walletService.getOrCreateSystemWallet('FEES_COLLECTED');
    feeTransaction = await walletService.moveFunds({
      fromWalletId: businessWallet.id,
      toWalletId: feesWallet.id,
      amount: feeAmount,
      type: 'FEE',
      idempotencyKey: `${idempotencyKey}:fee`,
      initiatedByUserId: null,
      metadata: { relatedTransactionId: payment.id, feeRate },
    });
  }

  if (!alreadyProcessed) {
    const businessName = business.businessProfile.businessName;
    const amountLabel = Number(amount).toLocaleString('fr-FR');

    await notifyUser(businessUserId, {
      type: 'PAYMENT_RECEIVED',
      title: 'Paiement reçu',
      body: `Paiement de ${amountLabel} GNF reçu de ${payerPhone} (Mobile Money)`,
      data: { transactionId: payment.id },
    }, `FlexPay : vous avez reçu un paiement de ${amountLabel} GNF.`);
  }

  return { payment, feeAmount, feeRate, feeTransaction };
}

// Permet à un compte Business de voir le statut de sa propre clé API,
// sans exposer le hash ni la clé elle-même - juste de quoi savoir "ai-je
// accès à l'API B2B, et sous quel nom partenaire". La création d'une clé
// reste exclusivement une action admin (voir admin.service.createApiClient).
// Un compte Business peut avoir jusqu'à 2 clés (une LIVE, une TEST) -
// findMany, pas findFirst, pour toujours les renvoyer toutes les deux.
async function getMyApiClientStatus(userId) {
  return prisma.apiClient.findMany({
    where: { businessUserId: userId },
    select: {
      id: true,
      name: true,
      apiKeyPrefix: true,
      environment: true,
      status: true,
      createdAt: true,
      webhookUrl: true,
      enabledExternalMethods: true,
    },
    orderBy: { environment: 'asc' }, // LIVE avant TEST, ordre alphabétique pratique ici
  });
}

async function requestTestApiKey(userId) {
  // Aucun argent réel ne pouvant jamais bouger avec une clé TEST (voir
  // paymentIntent.service.js), la générer soi-même sans validation admin
  // ne présente aucun risque financier - seule une clé LIVE reste
  // exclusivement créée par un admin (voir admin.service.createApiClient).
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { businessProfile: true },
  });

  if (!user || user.accountType !== 'BUSINESS') {
    throw new PaymentError('Seul un compte Business peut demander une clé API', 403);
  }
  if (user.businessProfile?.reviewStatus !== 'APPROVED') {
    throw new PaymentError('Votre compte Business doit être validé (KYB) avant de demander une clé', 403);
  }

  const existingTestKey = await prisma.apiClient.findFirst({
    where: { businessUserId: userId, environment: 'TEST' },
  });
  if (existingTestKey) {
    throw new PaymentError('Une clé de test existe déjà pour ce compte', 409);
  }

  const { raw, hash, prefix } = generateApiKey('test');

  const apiClient = await prisma.apiClient.create({
    data: {
      name: user.businessProfile.businessName,
      businessUserId: userId,
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      environment: 'TEST',
    },
  });

  return { apiClient, apiKey: raw };
}

// La clé brute n'étant jamais stockée (même logique qu'un mot de passe -
// voir apiKeyHash dans le schéma), il n'existe aucun moyen de la
// "réafficher" si elle est perdue. Seul recours : en générer une nouvelle,
// qui invalide immédiatement l'ancienne (même garantie que
// regenerateWebhookSecret, mais pour la clé elle-même). Fonctionne pour
// TEST comme pour LIVE - propriété vérifiée comme partout ailleurs ici.
async function regenerateApiKey(userId, apiClientId) {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } });
  if (!apiClient || apiClient.businessUserId !== userId) {
    throw new PaymentError('Clé API introuvable', 404);
  }

  const { raw, hash, prefix } = generateApiKey(apiClient.environment === 'LIVE' ? 'live' : 'test');

  const updated = await prisma.apiClient.update({
    where: { id: apiClientId },
    data: { apiKeyHash: hash, apiKeyPrefix: prefix },
  });

  return { apiClient: updated, apiKey: raw };
}

// --- Configuration du webhook (libre-service, propriété vérifiée) ------

async function setWebhookUrl(userId, apiClientId, webhookUrl) {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } });
  if (!apiClient || apiClient.businessUserId !== userId) {
    throw new PaymentError('Clé API introuvable', 404);
  }

  // Le secret n'est généré qu'une seule fois, à la première configuration
  // - une simple mise à jour de l'URL ne le régénère jamais (ça casserait
  // silencieusement la vérification de signature du partenaire).
  const isFirstSetup = !apiClient.webhookSecret;
  const rawSecret = isFirstSetup ? `whsec_${crypto.randomBytes(24).toString('hex')}` : null;
  // Stocké chiffré (pas en clair) : webhook.service.js le déchiffre au
  // moment de signer chaque envoi - voir encryption.js pour pourquoi un
  // hachage (comme un mot de passe) ne convient pas ici.
  const webhookSecretToStore = isFirstSetup ? encrypt(rawSecret) : apiClient.webhookSecret;

  await prisma.apiClient.update({
    where: { id: apiClientId },
    data: { webhookUrl, webhookSecret: webhookSecretToStore },
  });

  // Le secret n'est renvoyé en clair que la première fois - ensuite,
  // l'appelant doit utiliser regenerateWebhookSecret() s'il l'a perdu,
  // jamais une simple relecture.
  return { webhookUrl, webhookSecret: isFirstSetup ? rawSecret : null };
}

// Libre-service : le partenaire choisit lui-même quels moyens de paiement
// externes (sans compte FlexPay) proposer dans son propre checkout.
// FlexPay n'est jamais dans cette liste - il reste de droit toujours
// disponible pour tout partenaire, ce n'est pas une option qu'on active
// ou désactive (voir collectIntentExternally dans paymentIntent.service.js,
// qui vérifie le moyen choisi par le client final contre cette liste).
async function setEnabledExternalMethods(userId, apiClientId, enabledExternalMethods) {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } });
  if (!apiClient || apiClient.businessUserId !== userId) {
    throw new PaymentError('Clé API introuvable', 404);
  }

  await prisma.apiClient.update({ where: { id: apiClientId }, data: { enabledExternalMethods } });
  return { enabledExternalMethods };
}

async function regenerateWebhookSecret(userId, apiClientId) {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } });
  if (!apiClient || apiClient.businessUserId !== userId) {
    throw new PaymentError('Clé API introuvable', 404);
  }

  const rawSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  await prisma.apiClient.update({ where: { id: apiClientId }, data: { webhookSecret: encrypt(rawSecret) } });

  return { webhookSecret: rawSecret };
}

// --- Tableau de bord "Paiements reçus" pour une institution -----------------
// Répond directement au besoin d'une institution de savoir, sans avoir à
// interroger FlexPay, tous les paiements qu'elle a reçus - avec les
// champs personnalisés qu'elle a elle-même définis, affichés inline.
async function listReceivedPayments(businessUserId, query = {}) {
  const { page, pageSize, skip, take } = parsePagination(query);

  const where = {
    direction: 'CREDIT',
    wallet: { userId: businessUserId, ownerType: 'USER' },
    transaction: { type: 'MERCHANT_PAYMENT' },
  };

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      include: { transaction: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.ledgerEntry.count({ where }),
  ]);

  // Récupère les numéros des payeurs en un seul aller-retour plutôt
  // qu'un appel par ligne (évite le N+1 sur une liste potentiellement longue).
  const payerIds = [...new Set(entries.map((e) => e.transaction.initiatedByUserId).filter(Boolean))];
  const payers = await prisma.user.findMany({ where: { id: { in: payerIds } }, select: { id: true, phone: true } });
  const payerPhoneById = Object.fromEntries(payers.map((p) => [p.id, p.phone]));

  const items = entries.map((e) => ({
    transactionId: e.transaction.id,
    amount: Number(e.transaction.amount),
    createdAt: e.transaction.createdAt,
    // Un paiement invité (Mobile Money, sans compte FlexPay) n'a pas de
    // initiatedByUserId - son numéro est alors lu directement dans les
    // métadonnées de la transaction (voir payBusinessGuest).
    payerPhone: payerPhoneById[e.transaction.initiatedByUserId] || e.transaction.metadata?.payerPhone || null,
    channel: e.transaction.metadata?.channel || null,
    reference: e.transaction.metadata?.reference || null,
    customFields: e.transaction.metadata?.customFields || [],
  }));

  return buildPaginatedResult(items, total, page, pageSize);
}

// Résumé chiffré (encaissé / commission / net) pour le tableau de bord
// Business - séparé de listReceivedPayments (paginée, pour le détail ligne
// par ligne) car un total exact sur période ne doit pas dépendre de charger
// toutes les pages côté client. La commission est lue directement dans le
// grand livre (transactions FEE réellement débitées du wallet), jamais
// recalculée à partir d'un taux supposé - un compte avec feeRateOverride
// afficherait sinon un chiffre faux.
async function getReceivedPaymentsSummary(businessUserId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [grossAgg, feeAgg] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: {
        direction: 'CREDIT',
        wallet: { userId: businessUserId, ownerType: 'USER' },
        transaction: { type: 'MERCHANT_PAYMENT' },
        createdAt: { gte: since },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        direction: 'DEBIT',
        wallet: { userId: businessUserId, ownerType: 'USER' },
        transaction: { type: 'FEE' },
        createdAt: { gte: since },
      },
      _sum: { amount: true },
    }),
  ]);

  const grossAmount = Number(grossAgg._sum.amount || 0);
  const feeAmount = Number(feeAgg._sum.amount || 0);

  return {
    period: { days, since },
    grossAmount,
    feeAmount,
    netAmount: grossAmount - feeAmount,
    paymentCount: grossAgg._count._all,
  };
}

module.exports = {
  PaymentError,
  payBusiness,
  payBusinessGuest,
  getReceivedPaymentsSummary,
  getMyApiClientStatus,
  requestTestApiKey,
  regenerateApiKey,
  setWebhookUrl,
  setEnabledExternalMethods,
  regenerateWebhookSecret,
  listReceivedPayments,
};

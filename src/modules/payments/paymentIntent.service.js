const crypto = require('crypto');
const prisma = require('../../config/db');
const { assertWithinLimits } = require('../wallet/limits.guard');
const { payBusiness, payBusinessGuest, PaymentError } = require('./payments.service');
const { notifyUser } = require('../notifications/notification.service');
const { deliverWebhook } = require('./webhook.service');
const { parsePagination, buildPaginatedResult } = require('../../utils/pagination');
const externalPaymentsService = require('../externalPayments/externalPayments.service');

const INTENT_EXPIRES_MINUTES = 15;

// --- Créée par le partenaire (clé API) -------------------------------------

async function createIntent(apiClient, { payerPhone, amount, reference, idempotencyKey }) {
  const existing = await prisma.paymentIntent.findUnique({ where: { idempotencyKey } });
  if (existing) return existing; // idempotence côté partenaire aussi

  if (apiClient.environment === 'TEST') {
    return createTestIntent(apiClient, { payerPhone, amount, reference, idempotencyKey });
  }

  // Le payeur n'a plus besoin d'avoir déjà un compte FlexPay : s'il en a
  // un, l'intention se résout comme avant (notification in-app,
  // approbation par le payeur). Sinon, elle reste en attente jusqu'à ce
  // que le partenaire appelle collectIntentExternally avec le moyen que
  // son client final a choisi dans SON propre checkout (Orange Money,
  // MTN, carte - jamais pour contourner FlexPay, seulement pour les
  // clients qui n'ont pas de compte).
  const payer = await prisma.user.findUnique({ where: { phone: payerPhone } });
  const payerIsFlexPayUser = Boolean(payer && payer.status === 'ACTIVE');

  // Vérification anticipée des plafonds - évite de créer une intention
  // que l'utilisateur ne pourra de toute façon pas approuver, et qui
  // resterait bloquée jusqu'à expiration sans explication claire. Sans
  // objet si le payeur n'a pas de compte (pas de plafond à vérifier).
  if (payerIsFlexPayUser) {
    await assertWithinLimits(payer.id, amount);
  }

  const intent = await prisma.paymentIntent.create({
    data: {
      apiClientId: apiClient.id,
      environment: 'LIVE',
      payerUserId: payerIsFlexPayUser ? payer.id : null,
      payerPhone,
      amount,
      reference,
      idempotencyKey,
      expiresAt: new Date(Date.now() + INTENT_EXPIRES_MINUTES * 60 * 1000),
    },
  });

  // Notifie le payeur qu'une approbation est en attente dans l'app -
  // push en priorité (si un token est enregistré), SMS en filet de
  // sécurité automatique sinon (voir notification.service.js). Rien à
  // notifier s'il n'a pas de compte.
  if (payerIsFlexPayUser) {
    await notifyUser(
      payer.id,
      {
        type: 'PAYMENT_REQUEST_PENDING',
        title: 'Demande de paiement',
        body: `${apiClient.name} demande un paiement de ${amount} GNF`,
        data: { type: 'payment_intent', intentId: intent.id },
      },
      `${apiClient.name} demande un paiement de ${amount} GNF. Ouvrez FlexPay pour confirmer.`
    );
  }

  return intent;
}

// --- Mode TEST : aucune donnée financière réelle n'est jamais créée --------
//
// Différences volontaires par rapport au mode LIVE :
//   - payerPhone n'a besoin de correspondre à AUCUN utilisateur réel (un
//     développeur teste avec n'importe quel numéro fictif)
//   - aucun plafond vérifié (assertWithinLimits jamais appelé)
//   - aucun SMS envoyé (personne de réel à notifier)
//   - reste en PENDING_APPROVAL jusqu'à ce que le partenaire appelle
//     lui-même testResolveIntent() - jamais résolu automatiquement, pour
//     que le développeur puisse tester ses deux chemins de code (succès
//     ET échec) à volonté.
async function createTestIntent(apiClient, { payerPhone, amount, reference, idempotencyKey }) {
  return prisma.paymentIntent.create({
    data: {
      apiClientId: apiClient.id,
      environment: 'TEST',
      payerUserId: null,
      payerPhone,
      amount,
      reference,
      idempotencyKey,
      expiresAt: new Date(Date.now() + INTENT_EXPIRES_MINUTES * 60 * 1000),
    },
  });
}

// Simule la résolution d'une intention TEST - jamais de mouvement de
// fonds réel, jamais utilisable sur une intention LIVE (double
// vérification : appartenance à ce partenaire ET environnement TEST).
async function testResolveIntent(apiClient, intentId, outcome) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });

  if (!intent || intent.apiClientId !== apiClient.id) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  if (intent.environment !== 'TEST') {
    throw new PaymentError('Cette action ne peut être utilisée que sur une intention en mode test', 403);
  }
  if (intent.status !== 'PENDING_APPROVAL') {
    throw new PaymentError(`Cette demande n'est plus en attente (statut: ${intent.status})`, 409);
  }

  const status = outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  const transactionId = status === 'APPROVED' ? `test_tx_${crypto.randomUUID()}` : null;

  const updated = await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status, resolvedAt: new Date(), transactionId },
  });

  deliverWebhook(apiClient, status === 'APPROVED' ? 'payment_intent.approved' : 'payment_intent.rejected', {
    intentId: intent.id,
    amount: intent.amount,
    reference: intent.reference,
    transactionId,
    test: true,
  });

  return updated;
}

async function getIntentStatus(apiClient, intentId) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent || intent.apiClientId !== apiClient.id) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  return intent;
}

// Manquait jusqu'ici : un partenaire ne pouvait consulter que des
// intentions dont il connaissait déjà l'id (GET /api/intents/:id) - aucun
// moyen de parcourir/réconcilier l'ensemble de ses propres intentions.
async function listIntentsForApiClient(apiClient, { status, page, pageSize } = {}) {
  const { skip, take } = parsePagination({ page, pageSize });
  const where = { apiClientId: apiClient.id, ...(status ? { status } : {}) };

  const [items, total] = await Promise.all([
    prisma.paymentIntent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.paymentIntent.count({ where }),
  ]);

  return buildPaginatedResult(items, total, Math.max(1, parseInt(page, 10) || 1), take);
}

// Annulation côté PARTENAIRE (distinct de rejectIntent, qui est l'action
// du PAYEUR) - utile si le partenaire change d'avis avant toute réponse
// de l'utilisateur (ex: la commande associée a été annulée côté
// marchand). Jamais possible sur une intention déjà résolue.
async function cancelIntent(apiClient, intentId) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });

  if (!intent || intent.apiClientId !== apiClient.id) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  if (intent.status !== 'PENDING_APPROVAL') {
    throw new PaymentError(`Cette demande n'est plus en attente (statut: ${intent.status})`, 409);
  }

  return prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'CANCELLED', resolvedAt: new Date() },
  });
}

// Résout une intention pour un client final SANS compte FlexPay : appelé
// par le PARTENAIRE (sa clé API), après que SON propre checkout a
// collecté le moyen de paiement (Orange Money, MTN, carte) choisi par ce
// client. FlexPay reste toujours l'autre chemin possible (approveIntent,
// depuis l'app) - celui-ci n'existe que pour les clients qui n'ont pas de
// compte, jamais pour contourner FlexPay pour ceux qui en ont un.
async function collectIntentExternally(apiClient, intentId, { phone, provider }) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });

  if (!intent || intent.apiClientId !== apiClient.id) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  if (intent.status !== 'PENDING_APPROVAL') {
    throw new PaymentError(`Cette demande n'est plus en attente (statut: ${intent.status})`, 409);
  }
  if (intent.expiresAt < new Date()) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'EXPIRED', resolvedAt: new Date() } });
    throw new PaymentError('Cette demande de paiement a expiré', 410);
  }

  // Le partenaire choisit quels moyens externes activer dans son
  // checkout - jamais un choix du client final côté FlexPay. Un moyen
  // non activé est refusé même s'il figure dans la liste générale
  // EXTERNAL_PAYMENT_METHODS.
  const allowed = apiClient.enabledExternalMethods || [];
  if (!allowed.includes(provider)) {
    throw new PaymentError(`Ce partenaire n'a pas activé le paiement par ${provider}`, 403);
  }

  if (intent.environment === 'TEST') {
    // Même garantie que testResolveIntent : aucun mouvement de fonds réel.
    const transactionId = `test_tx_${crypto.randomUUID()}`;
    const updated = await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'APPROVED', resolvedAt: new Date(), transactionId },
    });
    deliverWebhook(apiClient, 'payment_intent.approved', {
      intentId: intent.id,
      amount: intent.amount,
      reference: intent.reference,
      transactionId,
      provider,
      test: true,
    });
    return { transactionId, feeAmount: 0, intent: updated };
  }

  const collection = await externalPaymentsService.collect({ phone, amount: Number(intent.amount), provider });
  if (collection.status !== 'COMPLETED') {
    throw new PaymentError(`Le paiement par ${provider} a échoué, réessayez`, 402);
  }

  const result = await payBusinessGuest({
    businessUserId: apiClient.businessUserId,
    amount: Number(intent.amount),
    payerPhone: phone,
    idempotencyKey: `intent:${intent.id}`,
    metadata: {
      reference: intent.reference,
      channel: 'api_external',
      partner: apiClient.name,
      provider,
      providerReference: collection.providerReference,
    },
  });

  const updated = await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'APPROVED', resolvedAt: new Date(), transactionId: result.payment.id },
  });

  deliverWebhook(apiClient, 'payment_intent.approved', {
    intentId: intent.id,
    amount: intent.amount,
    reference: intent.reference,
    transactionId: result.payment.id,
    provider,
  });

  return { transactionId: result.payment.id, feeAmount: result.feeAmount, intent: updated };
}

// --- Vue et actions côté utilisateur (dans l'app FlexPay) -------------------
// Les intentions TEST n'ont pas de payerUserId réel - elles n'apparaissent
// donc jamais dans la liste d'un utilisateur, ce qui est le comportement
// voulu : personne ne doit "voir" une intention de test dans son app.

async function listPendingIntentsForUser(userId) {
  await expireStaleIntents(userId);

  return prisma.paymentIntent.findMany({
    where: { payerUserId: userId, status: 'PENDING_APPROVAL', expiresAt: { gt: new Date() } },
    include: { apiClient: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function approveIntent(userId, intentId) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });

  if (!intent || intent.payerUserId !== userId) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  if (intent.status !== 'PENDING_APPROVAL') {
    throw new PaymentError(`Cette demande n'est plus en attente (statut: ${intent.status})`, 409);
  }
  if (intent.expiresAt < new Date()) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'EXPIRED', resolvedAt: new Date() } });
    throw new PaymentError('Cette demande de paiement a expiré', 410);
  }

  const apiClient = await prisma.apiClient.findUnique({ where: { id: intent.apiClientId } });

  const result = await payBusiness({
    payerUserId: userId,
    businessUserId: apiClient.businessUserId,
    amount: intent.amount,
    idempotencyKey: `intent:${intent.id}`,
    metadata: { reference: intent.reference, channel: 'api', partner: apiClient.name },
  });

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'APPROVED', resolvedAt: new Date(), transactionId: result.payment.id },
  });

  // Fire-and-forget : jamais attendu, ne doit jamais ralentir ni faire
  // échouer la confirmation déjà actée pour l'utilisateur.
  deliverWebhook(apiClient, 'payment_intent.approved', {
    intentId: intent.id,
    amount: intent.amount,
    reference: intent.reference,
    transactionId: result.payment.id,
  });

  return { transactionId: result.payment.id, feeAmount: result.feeAmount };
}

async function rejectIntent(userId, intentId) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });

  if (!intent || intent.payerUserId !== userId) {
    throw new PaymentError('Intention de paiement introuvable', 404);
  }
  if (intent.status !== 'PENDING_APPROVAL') {
    throw new PaymentError(`Cette demande n'est plus en attente (statut: ${intent.status})`, 409);
  }

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'REJECTED', resolvedAt: new Date() },
  });

  const apiClient = await prisma.apiClient.findUnique({ where: { id: intent.apiClientId } });
  deliverWebhook(apiClient, 'payment_intent.rejected', { intentId: intent.id, reference: intent.reference });
}

async function expireStaleIntents(userId) {
  await prisma.paymentIntent.updateMany({
    where: { payerUserId: userId, status: 'PENDING_APPROVAL', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED', resolvedAt: new Date() },
  });
}

module.exports = {
  createIntent,
  testResolveIntent,
  getIntentStatus,
  listIntentsForApiClient,
  cancelIntent,
  collectIntentExternally,
  listPendingIntentsForUser,
  approveIntent,
  rejectIntent,
};

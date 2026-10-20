const prisma = require('../../config/db');
const walletService = require('../wallet/wallet.service');
const { assertWithinLimits, LimitExceededError } = require('../wallet/limits.guard');
const { getBulkPayoutFeeRate } = require('../../config/fees');
const { notifyUser } = require('../notifications/notification.service');
const externalPaymentsService = require('../externalPayments/externalPayments.service');

const MAX_ITEMS_PER_BATCH = 500;

class BulkPayoutError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Coeur du traitement d'UNE ligne, partagé entre l'envoi initial et
// retryFailedItems - pour ne jamais faire diverger les deux chemins.
// Si le bénéficiaire a un compte FlexPay actif : wallet à wallet, comme
// toujours. Sinon, seulement si l'entreprise a choisi un moyen externe
// pour ce lot (externalPayoutMethod) : collecte simulée (mock) puis le
// montant quitte le wallet de l'entreprise vers le wallet système
// EXTERNAL_MOBILE_MONEY (même wallet que deposit/withdraw - "l'argent est
// sorti du système FlexPay"), plutôt que de faire échouer la ligne.
async function settleItem({ businessWallet, item, amount, idempotencyKey, businessUserId, feeRate, externalPayoutMethod, bulkPayoutId, retried = false }) {
  try {
    const recipient = await prisma.user.findUnique({ where: { phone: item.recipientPhone } });
    const recipientActive = Boolean(recipient && recipient.status === 'ACTIVE');

    if (!recipientActive && !externalPayoutMethod) {
      throw new Error("Ce numéro n'est pas inscrit ou n'est pas actif sur FlexPay");
    }

    await assertWithinLimits(businessUserId, amount);

    let tx;
    let payoutChannel = null;

    if (recipientActive) {
      const recipientWallet = await walletService.getOrCreateUserWallet(recipient.id);
      tx = await walletService.moveFunds({
        fromWalletId: businessWallet.id,
        toWalletId: recipientWallet.id,
        amount,
        type: 'TRANSFER',
        idempotencyKey,
        initiatedByUserId: businessUserId,
        metadata: { bulkPayoutId, reference: item.reference, ...(retried ? { retried: true } : {}) },
      });
    } else {
      const payoutResult = await externalPaymentsService.payout({ phone: item.recipientPhone, amount, provider: externalPayoutMethod });
      if (payoutResult.status !== 'COMPLETED') {
        throw new Error(`Échec de l'envoi via ${externalPayoutMethod}, réessayez`);
      }
      const externalWallet = await walletService.getOrCreateSystemWallet('EXTERNAL_MOBILE_MONEY');
      tx = await walletService.moveFunds({
        fromWalletId: businessWallet.id,
        toWalletId: externalWallet.id,
        amount,
        type: 'TRANSFER',
        idempotencyKey,
        initiatedByUserId: businessUserId,
        metadata: {
          bulkPayoutId,
          reference: item.reference,
          channel: 'external_payout',
          externalPayoutMethod,
          providerReference: payoutResult.providerReference,
          payerPhone: item.recipientPhone,
        },
      });
      payoutChannel = externalPayoutMethod;
    }

    const itemFee = Math.round(amount * feeRate);
    if (itemFee > 0) {
      const feesWallet = await walletService.getOrCreateSystemWallet('FEES_COLLECTED');
      await walletService.moveFunds({
        fromWalletId: businessWallet.id,
        toWalletId: feesWallet.id,
        amount: itemFee,
        type: 'FEE',
        idempotencyKey: `${idempotencyKey}:fee`,
        initiatedByUserId: businessUserId,
        metadata: { relatedTransactionId: tx.id, feeRate },
      });
    }

    return { status: 'SUCCESS', transactionId: tx.id, recipientUserId: recipientActive ? recipient.id : null, payoutChannel, failureReason: null };
  } catch (err) {
    const reason = err instanceof LimitExceededError || err.message ? err.message : 'Erreur inconnue';
    return { status: 'FAILED', failureReason: reason };
  }
}

async function createBulkPayout(businessUserId, { items, reference, idempotencyKey, externalPayoutMethod }) {
  if (items.length === 0) throw new BulkPayoutError('Aucun bénéficiaire fourni', 400);
  if (items.length > MAX_ITEMS_PER_BATCH) {
    throw new BulkPayoutError(`Maximum ${MAX_ITEMS_PER_BATCH} bénéficiaires par lot`, 400);
  }

  const existing = await prisma.bulkPayout.findUnique({ where: { idempotencyKey } });
  if (existing) return getBulkPayoutSummary(existing.id); // déjà traité, on renvoie l'état actuel

  const business = await prisma.user.findUnique({
    where: { id: businessUserId },
    include: { businessProfile: true },
  });
  if (!business || business.accountType !== 'BUSINESS') {
    throw new BulkPayoutError('Seul un compte Business peut effectuer un paiement en masse', 403);
  }

  // Frais à la charge de l'entreprise, en plus de chaque montant versé -
  // un bénéficiaire (salarié, agent de terrain...) reçoit toujours le
  // montant exact prévu, jamais amputé d'une commission qu'il ne devrait
  // pas supporter.
  const feeRate = getBulkPayoutFeeRate(business.businessProfile);
  const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
  const totalFees = items.reduce((sum, item) => sum + Math.round(item.amount * feeRate), 0);

  const businessWallet = await walletService.getOrCreateUserWallet(businessUserId);
  if (Number(businessWallet.balance) < totalAmount + totalFees) {
    throw new BulkPayoutError('Solde insuffisant pour couvrir le total du lot (frais inclus)', 400);
  }

  const bulkPayout = await prisma.bulkPayout.create({
    data: {
      initiatedByUserId: businessUserId,
      reference,
      idempotencyKey,
      totalAmount,
      items: {
        create: items.map((item) => ({
          recipientPhone: item.phone,
          amount: item.amount,
          reference: item.reference,
        })),
      },
    },
    include: { items: true },
  });

  // Traitement séquentiel, volontairement pas en parallèle : chaque ligne
  // vérifie les plafonds du payeur en tenant compte des lignes précédentes
  // déjà exécutées dans ce même lot (assertWithinLimits interroge le
  // solde réel à chaque appel). Du parallélisme casserait cette garantie.
  let successCount = 0;
  let failedCount = 0;

  for (const item of bulkPayout.items) {
    const outcome = await settleItem({
      businessWallet,
      item,
      amount: item.amount,
      idempotencyKey: `${idempotencyKey}:item:${item.id}`,
      businessUserId,
      feeRate,
      externalPayoutMethod,
      bulkPayoutId: bulkPayout.id,
    });

    await prisma.bulkPayoutItem.update({ where: { id: item.id }, data: outcome });
    if (outcome.status === 'SUCCESS') successCount += 1;
    else failedCount += 1;
  }

  const finalStatus =
    failedCount === 0 ? 'COMPLETED' : successCount === 0 ? 'FAILED' : 'PARTIALLY_FAILED';

  await prisma.bulkPayout.update({
    where: { id: bulkPayout.id },
    data: { status: finalStatus, successCount, failedCount, completedAt: new Date() },
  });

  await notifyUser(businessUserId, {
    type: 'BULK_PAYOUT_COMPLETED',
    title: failedCount === 0 ? 'Paiement en masse terminé' : 'Paiement en masse terminé avec des échecs',
    body: `${successCount} réussi(s), ${failedCount} échoué(s) sur ${bulkPayout.items.length} bénéficiaire(s)`,
    data: { bulkPayoutId: bulkPayout.id },
  });

  return getBulkPayoutSummary(bulkPayout.id);
}

async function getBulkPayoutSummary(id) {
  const bulkPayout = await prisma.bulkPayout.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!bulkPayout) throw new BulkPayoutError('Paiement en masse introuvable', 404);

  // Résout le nom des bénéficiaires déjà identifiés (recipientUserId
  // rempli) en un seul aller-retour - purement pour l'affichage, jamais
  // stocké sur la ligne elle-même (voir schéma BulkPayoutItem : aucune
  // colonne "nom", seul le numéro est garanti).
  const recipientIds = [...new Set(bulkPayout.items.map((i) => i.recipientUserId).filter(Boolean))];
  const recipients = recipientIds.length
    ? await prisma.user.findMany({ where: { id: { in: recipientIds } }, select: { id: true, fullName: true } })
    : [];
  const nameById = Object.fromEntries(recipients.map((r) => [r.id, r.fullName]));

  return {
    ...bulkPayout,
    items: bulkPayout.items.map((item) => ({
      ...item,
      recipientName: item.recipientUserId ? nameById[item.recipientUserId] || null : null,
    })),
  };
}

// Version avec vérification de propriété - à utiliser pour toute route
// atteignable par un utilisateur final (getBulkPayoutSummary seule ne
// vérifie rien et ne doit servir qu'en interne, ex: juste après création
// dans le même flux authentifié par construction).
async function getBulkPayoutSummaryForBusiness(businessUserId, id) {
  const bulkPayout = await getBulkPayoutSummary(id);
  if (bulkPayout.initiatedByUserId !== businessUserId) {
    // Même erreur qu'un id inexistant - ne jamais révéler qu'un lot
    // appartenant à quelqu'un d'autre existe bel et bien.
    throw new BulkPayoutError('Paiement en masse introuvable', 404);
  }
  return bulkPayout;
}

// Rejoue uniquement les lignes FAILED d'un lot déjà traité - jamais les
// lignes déjà SUCCESS (pas de double paiement). Réutilise volontairement
// la même idempotencyKey par ligne que la tentative initiale : comme
// aucune transaction n'a été créée pour une ligne qui a échoué avant
// d'atteindre moveFunds(), rejouer avec la même clé est à la fois sûr et
// nécessaire pour garder la garantie d'idempotence intacte.
async function retryFailedItems(businessUserId, bulkPayoutId, { externalPayoutMethod, itemIds } = {}) {
  const bulkPayout = await getBulkPayoutSummaryForBusiness(businessUserId, bulkPayoutId);

  // itemIds absent = comportement historique (tous les échecs). Fourni =
  // relance seulement les lignes sélectionnées dans le tableau de bord -
  // un id qui ne correspond à aucune ligne FAILED de CE lot (faute de
  // frappe côté appelant, ou ligne appartenant à un autre lot) est
  // simplement ignoré plutôt que de faire échouer tout le retry.
  const idSet = itemIds ? new Set(itemIds) : null;
  const failedItems = bulkPayout.items.filter((item) => item.status === 'FAILED' && (!idSet || idSet.has(item.id)));
  if (failedItems.length === 0) {
    throw new BulkPayoutError('Aucune ligne en échec à renvoyer sur ce lot', 400);
  }

  const business = await prisma.user.findUnique({
    where: { id: businessUserId },
    include: { businessProfile: true },
  });
  const feeRate = getBulkPayoutFeeRate(business?.businessProfile);

  const businessWallet = await walletService.getOrCreateUserWallet(businessUserId);
  const retryTotal = failedItems.reduce((sum, item) => sum + Number(item.amount), 0);
  const retryFees = failedItems.reduce((sum, item) => sum + Math.round(Number(item.amount) * feeRate), 0);
  if (Number(businessWallet.balance) < retryTotal + retryFees) {
    throw new BulkPayoutError('Solde insuffisant pour couvrir les lignes à renvoyer (frais inclus)', 400);
  }

  let newSuccessCount = 0;
  let newFailedCount = 0;

  for (const item of failedItems) {
    const outcome = await settleItem({
      businessWallet,
      item,
      amount: Number(item.amount),
      idempotencyKey: `${bulkPayout.idempotencyKey}:item:${item.id}`,
      businessUserId,
      feeRate,
      externalPayoutMethod,
      bulkPayoutId: bulkPayout.id,
      retried: true,
    });

    if (outcome.status === 'SUCCESS') {
      await prisma.bulkPayoutItem.update({ where: { id: item.id }, data: outcome });
      newSuccessCount += 1;
    } else {
      await prisma.bulkPayoutItem.update({ where: { id: item.id }, data: { failureReason: outcome.failureReason } });
      newFailedCount += 1;
    }
  }

  const finalSuccessCount = bulkPayout.successCount + newSuccessCount;
  const finalFailedCount = bulkPayout.failedCount - newSuccessCount; // les lignes réussies ne sont plus des échecs
  const finalStatus = finalFailedCount === 0 ? 'COMPLETED' : 'PARTIALLY_FAILED';

  await prisma.bulkPayout.update({
    where: { id: bulkPayout.id },
    data: { successCount: finalSuccessCount, failedCount: finalFailedCount, status: finalStatus },
  });

  await notifyUser(businessUserId, {
    type: 'BULK_PAYOUT_COMPLETED',
    title: finalFailedCount === 0 ? 'Renvoi terminé' : 'Renvoi terminé avec des échecs',
    body: `${newSuccessCount} ligne(s) réussie(s) sur ${failedItems.length} renvoyée(s)`,
    data: { bulkPayoutId: bulkPayout.id },
  });

  return getBulkPayoutSummary(bulkPayout.id);
}

async function listBulkPayoutsForBusiness(businessUserId) {
  return prisma.bulkPayout.findMany({
    where: { initiatedByUserId: businessUserId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      reference: true,
      totalAmount: true,
      successCount: true,
      failedCount: true,
      status: true,
      createdAt: true,
      completedAt: true,
    },
  });
}

module.exports = {
  BulkPayoutError,
  createBulkPayout,
  getBulkPayoutSummary,
  getBulkPayoutSummaryForBusiness,
  retryFailedItems,
  listBulkPayoutsForBusiness,
};

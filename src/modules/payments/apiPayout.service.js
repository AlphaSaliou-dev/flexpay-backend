const crypto = require('crypto');
const prisma = require('../../config/db');
const walletService = require('../wallet/wallet.service');
const { getApiPayoutFeeRate } = require('../../config/fees');
const { notifyUser } = require('../notifications/notification.service');
const { deliverWebhook } = require('./webhook.service');
const { parsePagination, buildPaginatedResult } = require('../../utils/pagination');
const { PaymentError } = require('./payments.service');

// Symétrique de PaymentIntent (pay-in) mais dans l'autre sens : ici c'est
// le PARTENAIRE qui pousse de l'argent vers un utilisateur (rembourser un
// client, payer un livreur...), immédiatement et sans approbation du
// bénéficiaire - recevoir de l'argent ne demande jamais de confirmation,
// contrairement à en payer (voir approveIntent). Les fonds sortent du
// wallet FlexPay du compte Business associé à la clé API, exactement
// comme pour un paiement en masse déclenché depuis le tableau de bord -
// le bénéficiaire reçoit toujours le montant exact prévu, jamais amputé
// d'une commission qu'il ne devrait pas supporter (le partenaire la paie
// en plus).
async function createPayout(apiClient, { recipientPhone, amount, reference, idempotencyKey, forceOutcome }) {
  const existing = await prisma.apiPayout.findUnique({ where: { idempotencyKey } });
  if (existing) return existing; // idempotence, comme pour createIntent

  if (apiClient.environment === 'TEST') {
    return createTestPayout(apiClient, { recipientPhone, amount, reference, idempotencyKey, forceOutcome });
  }

  const recipient = await prisma.user.findUnique({ where: { phone: recipientPhone } });
  if (!recipient || recipient.status !== 'ACTIVE') {
    throw new PaymentError('Bénéficiaire introuvable ou inactif', 404);
  }

  const businessProfile = await prisma.businessProfile.findUnique({ where: { userId: apiClient.businessUserId } });
  const feeRate = getApiPayoutFeeRate(businessProfile);
  const feeAmount = Math.round(Number(amount) * feeRate);

  const businessWallet = await walletService.getOrCreateUserWallet(apiClient.businessUserId);
  if (Number(businessWallet.balance) < Number(amount) + feeAmount) {
    throw new PaymentError('Solde insuffisant pour ce versement (frais inclus)', 400);
  }

  const recipientWallet = await walletService.getOrCreateUserWallet(recipient.id);

  const tx = await walletService.moveFunds({
    fromWalletId: businessWallet.id,
    toWalletId: recipientWallet.id,
    amount,
    type: 'TRANSFER',
    idempotencyKey: `payout:${idempotencyKey}`,
    initiatedByUserId: apiClient.businessUserId,
    metadata: { reference, partner: apiClient.name, channel: 'api_payout' },
  });

  if (feeAmount > 0) {
    const feesWallet = await walletService.getOrCreateSystemWallet('FEES_COLLECTED');
    await walletService.moveFunds({
      fromWalletId: businessWallet.id,
      toWalletId: feesWallet.id,
      amount: feeAmount,
      type: 'FEE',
      idempotencyKey: `payout:${idempotencyKey}:fee`,
      initiatedByUserId: apiClient.businessUserId,
      metadata: { relatedTransactionId: tx.id, feeRate },
    });
  }

  const payout = await prisma.apiPayout.create({
    data: {
      apiClientId: apiClient.id,
      environment: 'LIVE',
      recipientPhone: recipient.phone,
      recipientUserId: recipient.id,
      amount,
      reference,
      idempotencyKey,
      status: 'COMPLETED',
      transactionId: tx.id,
      completedAt: new Date(),
    },
  });

  const amountLabel = Number(amount).toLocaleString('fr-FR');
  await notifyUser(
    recipient.id,
    {
      type: 'TRANSFER_RECEIVED',
      title: 'Virement reçu',
      body: `Virement de ${amountLabel} GNF reçu de ${apiClient.name}`,
      data: { transactionId: tx.id },
    },
    `FlexPay : vous avez reçu un virement de ${amountLabel} GNF de ${apiClient.name}.`
  );

  deliverWebhook(apiClient, 'payout.completed', {
    payoutId: payout.id,
    amount: Number(amount),
    reference,
    transactionId: tx.id,
  });

  return payout;
}

// --- Mode TEST : aucune donnée financière réelle n'est jamais créée --------
// Contrairement à un PaymentIntent, un payout n'a pas d'étape d'approbation
// humaine à simuler - il se résout donc immédiatement, comme en LIVE.
// forceOutcome ('COMPLETED' par défaut, ou 'FAILED') permet au partenaire
// de tester volontairement son propre chemin de gestion d'erreur - un
// simulateur d'échec qui manquait jusqu'ici au bac à sable.
async function createTestPayout(apiClient, { recipientPhone, amount, reference, idempotencyKey, forceOutcome }) {
  const status = forceOutcome === 'FAILED' ? 'FAILED' : 'COMPLETED';

  const payout = await prisma.apiPayout.create({
    data: {
      apiClientId: apiClient.id,
      environment: 'TEST',
      recipientPhone,
      recipientUserId: null,
      amount,
      reference,
      idempotencyKey,
      status,
      transactionId: status === 'COMPLETED' ? `test_tx_${crypto.randomUUID()}` : null,
      failureReason: status === 'FAILED' ? 'Échec simulé (forceOutcome=FAILED)' : null,
      completedAt: status === 'COMPLETED' ? new Date() : null,
    },
  });

  deliverWebhook(apiClient, status === 'COMPLETED' ? 'payout.completed' : 'payout.failed', {
    payoutId: payout.id,
    amount: Number(amount),
    reference,
    transactionId: payout.transactionId,
    test: true,
  });

  return payout;
}

async function getPayoutStatus(apiClient, payoutId) {
  const payout = await prisma.apiPayout.findUnique({ where: { id: payoutId } });
  if (!payout || payout.apiClientId !== apiClient.id) {
    throw new PaymentError('Versement introuvable', 404);
  }
  return payout;
}

async function listPayoutsForApiClient(apiClient, { status, page, pageSize } = {}) {
  const { skip, take } = parsePagination({ page, pageSize });
  const where = { apiClientId: apiClient.id, ...(status ? { status } : {}) };

  const [items, total] = await Promise.all([
    prisma.apiPayout.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.apiPayout.count({ where }),
  ]);

  return buildPaginatedResult(items, total, Math.max(1, parseInt(page, 10) || 1), take);
}

module.exports = { createPayout, getPayoutStatus, listPayoutsForApiClient };

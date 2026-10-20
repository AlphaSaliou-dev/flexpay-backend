const prisma = require('../../config/db');
const walletService = require('./wallet.service');
const { notifyUser } = require('../notifications/notification.service');

class RefundError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const REFUNDABLE_TYPES = ['MERCHANT_PAYMENT', 'TRANSFER'];

// Remboursement volontairement réservé à un admin (voir routes) : c'est
// un mouvement d'argent qui inverse la volonté initiale de l'utilisateur
// receveur (on lui reprend de l'argent), donc jamais déclenchable par le
// payeur seul en self-service - ça ouvrirait la porte à des remboursements
// abusifs sans validation.
async function refundTransaction(adminId, transactionId, reason) {
  if (!reason || !reason.trim()) {
    throw new RefundError('Un motif de remboursement est requis', 400);
  }

  const original = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { ledgerEntries: true },
  });

  if (!original) throw new RefundError('Transaction introuvable', 404);
  if (!REFUNDABLE_TYPES.includes(original.type)) {
    throw new RefundError(`Une transaction de type ${original.type} ne peut pas être remboursée`, 400);
  }
  if (original.status !== 'COMPLETED') {
    throw new RefundError(`Cette transaction n'est pas dans un état remboursable (statut : ${original.status})`, 409);
  }

  const alreadyRefunded = await prisma.transaction.findFirst({
    where: { reversalOfTransactionId: transactionId },
  });
  if (alreadyRefunded) {
    throw new RefundError('Cette transaction a déjà été remboursée', 409);
  }

  const debitEntry = original.ledgerEntries.find((e) => e.direction === 'DEBIT');
  const creditEntry = original.ledgerEntries.find((e) => e.direction === 'CREDIT');

  if (!debitEntry || !creditEntry) {
    // Un signal de réconciliation aurait dû détecter ça avant qu'on
    // n'essaie de rembourser - voir reconciliation.service.js.
    throw new RefundError("Transaction originale mal formée (écritures manquantes) - contacter le support technique", 500);
  }

  // Le remboursement inverse exactement le mouvement d'origine : celui
  // qui avait reçu (creditEntry.walletId) renvoie vers celui qui avait
  // payé (debitEntry.walletId). moveFunds() applique déjà tous les
  // contrôles habituels (solde suffisant côté remboursement, plafonds,
  // partie double) - aucune logique dupliquée ici.
  const refundTx = await walletService.moveFunds({
    fromWalletId: creditEntry.walletId,
    toWalletId: debitEntry.walletId,
    amount: debitEntry.amount,
    type: 'REFUND',
    idempotencyKey: `refund:${transactionId}`,
    initiatedByUserId: adminId,
    metadata: { reversalOf: transactionId, reason },
  });

  await prisma.transaction.update({
    where: { id: transactionId },
    data: { status: 'REVERSED' },
  });
  await prisma.transaction.update({
    where: { id: refundTx.id },
    data: { reversalOfTransactionId: transactionId },
  });

  // Le remboursement crédite le wallet qui avait payé à l'origine
  // (debitEntry.walletId) - c'est son titulaire qu'on notifie, pas
  // l'admin qui a déclenché l'action.
  const recipientWallet = await prisma.wallet.findUnique({ where: { id: debitEntry.walletId } });
  if (recipientWallet?.userId) {
    await notifyUser(recipientWallet.userId, {
      type: 'REFUND_RECEIVED',
      title: 'Remboursement reçu',
      body: `Remboursement de ${Number(debitEntry.amount).toLocaleString('fr-FR')} GNF reçu`,
      data: { transactionId: refundTx.id },
    }, `FlexPay : vous avez reçu un remboursement de ${Number(debitEntry.amount).toLocaleString('fr-FR')} GNF.`);
  }

  return refundTx;
}

module.exports = { RefundError, refundTransaction };

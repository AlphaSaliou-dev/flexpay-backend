const prisma = require('../../config/db');
const { assertWithinLimits, LimitExceededError } = require('./limits.guard');
const { getLimitsForUser } = require('../../config/limits');
const { notifyUser } = require('../notifications/notification.service');
const externalPaymentsService = require('../externalPayments/externalPayments.service');
const { getWithdrawalFeeRate, getExternalTransferFeeRate } = require('../../config/fees');

class WalletError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// --- Wallets -----------------------------------------------------------

async function getOrCreateUserWallet(userId) {
  const existing = await prisma.wallet.findUnique({ where: { userId } });
  if (existing) return existing;

  return prisma.wallet.create({
    data: { ownerType: 'USER', userId, balance: 0 },
  });
}

async function getOrCreateSystemWallet(systemKind) {
  const existing = await prisma.wallet.findUnique({ where: { systemKind } });
  if (existing) return existing;

  return prisma.wallet.create({
    data: { ownerType: 'SYSTEM', systemKind, balance: 0 },
  });
}

async function getBalance(userId) {
  const wallet = await getOrCreateUserWallet(userId);
  return { balance: Number(wallet.balance), currency: wallet.currency };
}

async function getHistory(userId, { limit = 50 } = {}) {
  const wallet = await getOrCreateUserWallet(userId);
  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { transaction: true },
  });

  return entries.map((e) => ({
    direction: e.direction,
    amount: Number(e.amount),
    balanceAfter: Number(e.balanceAfter),
    type: e.transaction.type,
    status: e.transaction.status,
    createdAt: e.createdAt,
  }));
}

// --- Coeur du ledger : mouvement atomique entre deux wallets -------------
//
// Débite `fromWalletId` et crédite `toWalletId` du même montant, dans une
// seule transaction DB. Verrouille les deux lignes Wallet (SELECT ... FOR
// UPDATE) pour empêcher deux mouvements concurrents de lire un solde
// périmé - sans ce verrou, deux retraits simultanés pourraient tous les
// deux voir "solde suffisant" et faire passer le compte en négatif.
//
// L'ordre de verrouillage (toujours par id trié) évite les interblocages
// (deadlocks) si deux transactions s'exécutent en sens inverse en même temps.
async function moveFunds({ fromWalletId, toWalletId, amount, type, idempotencyKey, initiatedByUserId, metadata }) {
  const amountNum = Number(amount);
  if (amountNum <= 0) throw new WalletError('Montant invalide', 400);

  const existingTx = await prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (existingTx) {
    // Requête déjà traitée (retry réseau, double-clic) : on renvoie le
    // résultat existant au lieu de rejouer le mouvement d'argent.
    return existingTx;
  }

  const [firstId, secondId] = [fromWalletId, toWalletId].sort();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${firstId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${secondId} FOR UPDATE`;

    const fromWallet = await tx.wallet.findUnique({ where: { id: fromWalletId } });
    const toWallet = await tx.wallet.findUnique({ where: { id: toWalletId } });

    if (!fromWallet || !toWallet) throw new WalletError('Wallet introuvable', 404);
    if (fromWallet.frozen || toWallet.frozen) throw new WalletError('Wallet gelé', 403);

    if (fromWallet.ownerType === 'USER' && Number(fromWallet.balance) < amountNum) {
      throw new WalletError('Solde insuffisant', 400);
    }

    const newFromBalance = Number(fromWallet.balance) - amountNum;
    const newToBalance = Number(toWallet.balance) + amountNum;

    // Plafond de solde : un wallet USER ne peut jamais dépasser le maximum
    // de son palier KYC, même si l'opération respecte par ailleurs les
    // plafonds de flux (par transaction/jour/mois). Vérifié ici, dans la
    // même transaction verrouillée, pour couvrir TOUT chemin de crédit
    // (dépôt, transfert reçu, paiement reçu) sans dépendre de chaque
    // appelant pour y penser séparément.
    if (toWallet.ownerType === 'USER') {
      const recipient = await tx.user.findUnique({
        where: { id: toWallet.userId },
        include: { kycProfile: true, businessProfile: true },
      });
      const limits = getLimitsForUser(recipient);
      if (newToBalance > limits.maxBalance) {
        throw new WalletError(
          `Ce dépôt dépasserait le plafond de solde autorisé (${limits.maxBalance.toLocaleString('fr-FR')} GNF) pour ce compte`,
          403
        );
      }
    }

    const transaction = await tx.transaction.create({
      data: {
        type,
        status: 'COMPLETED',
        idempotencyKey,
        initiatedByUserId,
        amount: amountNum,
        metadata,
        completedAt: new Date(),
      },
    });

    await tx.wallet.update({ where: { id: fromWallet.id }, data: { balance: newFromBalance } });
    await tx.wallet.update({ where: { id: toWallet.id }, data: { balance: newToBalance } });

    await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        walletId: fromWallet.id,
        direction: 'DEBIT',
        amount: amountNum,
        balanceAfter: newFromBalance,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        walletId: toWallet.id,
        direction: 'CREDIT',
        amount: amountNum,
        balanceAfter: newToBalance,
      },
    });

    return transaction;
  });
}

// --- Opérations exposées --------------------------------------------------

async function deposit(userId, { amount, idempotencyKey, provider }) {
  if (provider === 'bank') {
    throw new WalletError('Les dépôts depuis un compte bancaire ne sont pas encore disponibles', 400);
  }

  // Vérifié AVANT tout appel au fournisseur externe : sans ce contrôle, un
  // retry réseau d'une requête déjà traitée redéclencherait une seconde
  // demande de confirmation (USSD/push) chez le vrai opérateur pour un
  // dépôt déjà crédité.
  const alreadyProcessed = await prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (alreadyProcessed) return alreadyProcessed;

  // Le solde crédité ici doit correspondre à de l'argent réellement reçu
  // par FlexPay auprès de l'opérateur, jamais à une simple déclaration du
  // client. On ne fait donc jamais confiance à une référence fournie par
  // l'appelant : c'est le serveur qui interroge le fournisseur (même
  // abstraction que pour les paiements entrants - collect()), et c'est la
  // référence RENVOYÉE par le fournisseur qui est enregistrée. En mode
  // mock, collect() réussit toujours instantanément ; une fois un vrai
  // partenaire branché (EXTERNAL_PAYMENT_PROVIDER), ce même appel attend
  // la confirmation réelle du débit chez l'opérateur avant de créditer.
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const collection = await externalPaymentsService.collect({ phone: user.phone, amount, provider });
  if (collection.status !== 'COMPLETED') {
    throw new WalletError(`Le dépôt via ${provider} a échoué, réessayez`, 402);
  }

  const userWallet = await getOrCreateUserWallet(userId);
  const externalWallet = await getOrCreateSystemWallet('EXTERNAL_MOBILE_MONEY');

  const result = await moveFunds({
    fromWalletId: externalWallet.id,
    toWalletId: userWallet.id,
    amount,
    type: 'DEPOSIT',
    idempotencyKey,
    initiatedByUserId: userId,
    metadata: { provider, providerReference: collection.providerReference },
  });

  await notifyUser(userId, {
    type: 'DEPOSIT_RECEIVED',
    title: 'Dépôt reçu',
    body: `Dépôt de ${amount.toLocaleString('fr-FR')} GNF reçu`,
    data: { transactionId: result.id },
  });

  return result;
}

async function withdraw(userId, { amount, idempotencyKey, provider }) {
  if (provider === 'bank') {
    throw new WalletError('Les retraits vers un compte bancaire ne sont pas encore disponibles', 400);
  }

  await assertWithinLimits(userId, amount);

  const alreadyProcessed = await prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (alreadyProcessed) return alreadyProcessed;

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { businessProfile: true } });
  // Commission FlexPay sur le retrait (décision du 2026-10-18, voir
  // config/fees.js) - prélevée EN PLUS du montant demandé : l'utilisateur
  // reçoit exactement le montant qu'il a demandé chez l'opérateur, c'est
  // son wallet FlexPay qui est débité du montant + la commission.
  const feeAmount = Math.round(Number(amount) * getWithdrawalFeeRate(user?.businessProfile));

  const userWallet = await getOrCreateUserWallet(userId);
  if (Number(userWallet.balance) < Number(amount) + feeAmount) {
    throw new WalletError('Solde insuffisant', 400);
  }

  // Même ordre que le paiement en masse externe (bulkPayout.service.js,
  // settleItem) : on interroge d'ABORD le fournisseur et on ne débite le
  // wallet FlexPay qu'après confirmation réelle du versement, jamais
  // l'inverse - sinon un retrait marqué "complété" côté FlexPay pourrait
  // ne jamais arriver chez l'utilisateur. Le contrôle de solde ci-dessus
  // réduit la fenêtre de course avec un retrait concurrent sur le même
  // compte sans l'éliminer totalement (seul moveFunds(), plus bas, est
  // réellement verrouillé) - limite acceptée pour l'instant.
  const payoutResult = await externalPaymentsService.payout({ phone: user.phone, amount, provider });
  if (payoutResult.status !== 'COMPLETED') {
    throw new WalletError(`Le retrait via ${provider} a échoué, réessayez`, 402);
  }

  const externalWallet = await getOrCreateSystemWallet('EXTERNAL_MOBILE_MONEY');

  const result = await moveFunds({
    fromWalletId: userWallet.id,
    toWalletId: externalWallet.id,
    amount,
    type: 'WITHDRAWAL',
    idempotencyKey,
    initiatedByUserId: userId,
    metadata: { provider, providerReference: payoutResult.providerReference, feeAmount },
  });

  if (feeAmount > 0) {
    const feesWallet = await getOrCreateSystemWallet('FEES_COLLECTED');
    await moveFunds({
      fromWalletId: userWallet.id,
      toWalletId: feesWallet.id,
      amount: feeAmount,
      type: 'FEE',
      idempotencyKey: `${idempotencyKey}:fee`,
      initiatedByUserId: userId,
      metadata: { relatedTo: 'WITHDRAWAL', transactionId: result.id },
    });
  }

  await notifyUser(userId, {
    type: 'WITHDRAWAL_COMPLETED',
    title: 'Retrait effectué',
    body: feeAmount > 0
      ? `Retrait de ${amount.toLocaleString('fr-FR')} GNF effectué (frais : ${feeAmount.toLocaleString('fr-FR')} GNF)`
      : `Retrait de ${amount.toLocaleString('fr-FR')} GNF effectué`,
    data: { transactionId: result.id },
  });

  return result;
}

const EXTERNAL_PAYOUT_METHOD_LABELS = { orange_money: 'Orange Money', mtn_momo: 'MTN Mobile Money', card: 'carte' };

async function transfer(fromUserId, { toPhone, amount, idempotencyKey, externalPayoutMethod }) {
  await assertWithinLimits(fromUserId, amount);

  const recipientUser = await prisma.user.findUnique({ where: { phone: toPhone } });
  const recipientActive = Boolean(recipientUser && recipientUser.status === 'ACTIVE');

  if (recipientUser && recipientUser.id === fromUserId) {
    throw new WalletError('Impossible de vous transférer à vous-même', 400);
  }
  // Comportement historique inchangé si l'expéditeur n'a pas choisi de
  // repli : seul un compte FlexPay actif peut recevoir. S'il en choisit
  // un, même principe que le paiement en masse (bulkPayout.service.js) -
  // l'argent part quand même, vers l'opérateur mobile money du
  // destinataire, plutôt que de bloquer l'envoi.
  if (!recipientActive && !externalPayoutMethod) {
    throw new WalletError('Destinataire introuvable', 404);
  }

  // Vérifié AVANT tout appel au fournisseur externe (même raison que
  // deposit()/withdraw()) : un webhook ou un retry réseau rejoué ne doit
  // jamais redéclencher un second envoi réel vers l'opérateur.
  const alreadyProcessed = await prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (alreadyProcessed) return alreadyProcessed;

  const fromWallet = await getOrCreateUserWallet(fromUserId);
  const fromUser = await prisma.user.findUnique({ where: { id: fromUserId }, include: { businessProfile: true } });

  let result;
  let feeAmount = 0;
  if (recipientActive) {
    // FlexPay-vers-FlexPay : toujours 100% gratuit, aucune commission -
    // c'est volontaire (voir getExternalTransferFeeRate), pour inciter à
    // faire grossir le réseau FlexPay plutôt qu'à payer à chaque envoi.
    const toWallet = await getOrCreateUserWallet(recipientUser.id);
    result = await moveFunds({
      fromWalletId: fromWallet.id,
      toWalletId: toWallet.id,
      amount,
      type: 'TRANSFER',
      idempotencyKey,
      initiatedByUserId: fromUserId,
      metadata: { toUserId: recipientUser.id },
    });
  } else {
    // Commission FlexPay sur la sortie réelle vers un autre opérateur
    // (décision du 2026-10-18, voir config/fees.js) - prélevée EN PLUS du
    // montant demandé, même principe que withdraw().
    feeAmount = Math.round(Number(amount) * getExternalTransferFeeRate(fromUser?.businessProfile));
    if (Number(fromWallet.balance) < Number(amount) + feeAmount) {
      throw new WalletError('Solde insuffisant', 400);
    }

    // Pas de référence fournie par le client : le serveur interroge
    // lui-même l'opérateur (payout()) et ne débite que sur confirmation
    // réelle - voir wallet.service.js deposit()/withdraw().
    const payoutResult = await externalPaymentsService.payout({ phone: toPhone, amount, provider: externalPayoutMethod });
    if (payoutResult.status !== 'COMPLETED') {
      throw new WalletError(`L'envoi via ${EXTERNAL_PAYOUT_METHOD_LABELS[externalPayoutMethod] || externalPayoutMethod} a échoué, réessayez`, 402);
    }
    const externalWallet = await getOrCreateSystemWallet('EXTERNAL_MOBILE_MONEY');
    result = await moveFunds({
      fromWalletId: fromWallet.id,
      toWalletId: externalWallet.id,
      amount,
      type: 'TRANSFER',
      idempotencyKey,
      initiatedByUserId: fromUserId,
      metadata: {
        channel: 'external_payout',
        externalPayoutMethod,
        recipientPhone: toPhone,
        providerReference: payoutResult.providerReference,
        feeAmount,
      },
    });

    if (feeAmount > 0) {
      const feesWallet = await getOrCreateSystemWallet('FEES_COLLECTED');
      await moveFunds({
        fromWalletId: fromWallet.id,
        toWalletId: feesWallet.id,
        amount: feeAmount,
        type: 'FEE',
        idempotencyKey: `${idempotencyKey}:fee`,
        initiatedByUserId: fromUserId,
        metadata: { relatedTo: 'TRANSFER', transactionId: result.id },
      });
    }
  }

  const amountLabel = amount.toLocaleString('fr-FR');
  await notifyUser(fromUserId, {
    type: 'TRANSFER_SENT',
    title: 'Transfert envoyé',
    body: recipientActive
      ? `Transfert de ${amountLabel} GNF à ${recipientUser.fullName || recipientUser.phone}`
      : `Transfert de ${amountLabel} GNF envoyé via ${EXTERNAL_PAYOUT_METHOD_LABELS[externalPayoutMethod] || externalPayoutMethod}${feeAmount > 0 ? ` (frais : ${feeAmount.toLocaleString('fr-FR')} GNF)` : ''}`,
    data: { transactionId: result.id },
  });
  if (recipientActive) {
    await notifyUser(recipientUser.id, {
      type: 'TRANSFER_RECEIVED',
      title: 'Transfert reçu',
      body: `Transfert de ${amountLabel} GNF reçu de ${fromUser?.fullName || fromUser?.phone || 'un utilisateur FlexPay'}`,
      data: { transactionId: result.id },
    }, `FlexPay : vous avez reçu un transfert de ${amountLabel} GNF.`);
  }

  return result;
}

// Résout un numéro en aperçu de destinataire AVANT que l'utilisateur ne
// saisisse un montant - transfer() échoue sinon seulement à la toute fin
// avec "Destinataire introuvable". Ne renvoie que des champs sûrs à
// afficher publiquement (jamais solde, statut KYC, etc.) : c'est déjà ce
// que révèle un transfert réussi ou raté, on ne fait qu'anticiper l'info.
async function lookupRecipient(fromUserId, phone) {
  if (!phone || !/^\+224\d{8,9}$/.test(phone)) {
    throw new WalletError('Numéro invalide', 400);
  }
  const recipient = await prisma.user.findUnique({ where: { phone } });
  if (!recipient || recipient.status !== 'ACTIVE') return { exists: false };
  if (recipient.id === fromUserId) return { exists: false };

  // Require tardif (dans la fonction, pas en haut du fichier) : évite une
  // dépendance circulaire avec smsCommand.service.js, qui require lui-même
  // wallet.service.js. L'app mémorise cette référence pendant qu'elle est
  // en ligne, pour pouvoir l'utiliser plus tard dans une commande SMS hors
  // ligne sans jamais exposer le numéro réel du destinataire - voir la
  // décision actée dans project_flexpay (mode hors ligne SMS, 2026-10-18).
  const { getOrCreateSmsReference } = require('../smsCommands/smsCommand.service');
  const smsReference = await getOrCreateSmsReference(recipient.id);

  return { exists: true, fullName: recipient.fullName || null, smsReference };
}

module.exports = {
  WalletError,
  LimitExceededError,
  getBalance,
  getHistory,
  deposit,
  withdraw,
  transfer,
  lookupRecipient,
  moveFunds,
  getOrCreateUserWallet,
  getOrCreateSystemWallet,
};

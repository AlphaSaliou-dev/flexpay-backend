const prisma = require('../../config/db');
const walletService = require('../wallet/wallet.service');
const { assertWithinLimits } = require('../wallet/limits.guard');
const { VIRTUAL_CARD_TOPUP_FEE_RATE } = require('../../config/fees');
const { gnfToUsd, usdToGnf } = require('../../config/exchangeRates');
const { notifyUser } = require('../notifications/notification.service');

// La carte reste toujours en USD (devise carte, voir VirtualCard.currency) -
// cet équivalent GNF n'est qu'un affichage indicatif côté app pour un
// utilisateur qui raisonne au quotidien en GNF, jamais une vraie conversion
// de fonds (aucun mouvement de wallet ne se fait dans cette devise).
function withGnfEquivalent(card) {
  return { ...card, balanceGnfEquivalent: usdToGnf(Number(card.balance)) };
}

// Sélection du fournisseur via variable d'environnement. Un seul point de
// changement quand un vrai partenaire sera choisi (voir
// cardProvider.interface.js pour le contrat attendu).
const CARD_PROVIDER = process.env.CARD_PROVIDER || 'mock';
const provider = require(`./providers/${CARD_PROVIDER}Provider`);

class VirtualCardError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// --- Émission de la carte ---------------------------------------------------

async function issueCard(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { kycProfile: true },
  });

  if (!user) throw new VirtualCardError('Utilisateur introuvable', 404);

  // La carte virtuelle touche à l'international - on exige le palier de
  // vérification le plus élevé, pas de dérogation possible ici.
  if (user.kycProfile?.tier !== 'TIER_2') {
    throw new VirtualCardError(
      "Une pièce d'identité vérifiée (palier 2) est requise pour obtenir une carte virtuelle",
      403
    );
  }

  const existing = await prisma.virtualCard.findUnique({ where: { userId } });
  if (existing) throw new VirtualCardError('Une carte existe déjà pour ce compte', 409);

  const issued = await provider.createCard(user);

  const card = await prisma.virtualCard.create({
    data: {
      userId,
      provider: CARD_PROVIDER,
      providerCardId: issued.providerCardId,
      maskedNumber: issued.maskedNumber,
      currency: issued.currency,
      status: 'ACTIVE',
    },
  });

  await notifyUser(userId, {
    type: 'VIRTUAL_CARD_ISSUED',
    title: 'Carte virtuelle émise',
    body: `Votre carte virtuelle ${issued.maskedNumber} est prête.`,
    data: { cardId: card.id },
  });

  return withGnfEquivalent(card);
}

async function getMyCard(userId) {
  const card = await prisma.virtualCard.findUnique({ where: { userId } });
  if (!card) throw new VirtualCardError('Aucune carte virtuelle pour ce compte', 404);
  return withGnfEquivalent(card);
}

// Numéro complet, CVC et expiration - jamais stockés en base (voir le
// modèle VirtualCard), demandés au fournisseur à chaque révélation et
// protégés par un code de confirmation comme toute action sensible.
async function revealDetails(userId) {
  const card = await getMyCard(userId);
  // Le gel bloque les paiements, pas la consultation : seule une carte
  // fermée n'a plus de numéro à montrer.
  if (card.status === 'CLOSED' || card.status === 'PENDING_ISSUANCE') {
    throw new VirtualCardError(`Carte non disponible (statut: ${card.status})`, 403);
  }
  return provider.getCardDetails(card.providerCardId, card.maskedNumber);
}

// --- Rechargement ------------------------------------------------------------
// Le montant est débité du wallet FlexPay (GNF) ; la commission est prélevée
// séparément, comme pour un paiement marchand - deux lignes claires dans
// l'historique plutôt qu'un seul mouvement qui mélange principal et frais.

async function topUp(userId, amountGnf) {
  const card = await getMyCard(userId);

  if (card.status !== 'ACTIVE') {
    throw new VirtualCardError(`Carte non active (statut: ${card.status})`, 403);
  }

  await assertWithinLimits(userId, amountGnf);

  const userWallet = await walletService.getOrCreateUserWallet(userId);
  const cardProviderWallet = await walletService.getOrCreateSystemWallet('EXTERNAL_CARD_PROVIDER');
  const idempotencyKey = `card-topup:${card.id}:${Date.now()}`;

  const topupTx = await walletService.moveFunds({
    fromWalletId: userWallet.id,
    toWalletId: cardProviderWallet.id,
    amount: amountGnf,
    type: 'CARD_TOPUP',
    idempotencyKey,
    initiatedByUserId: userId,
    metadata: { cardId: card.id },
  });

  const feeAmount = Math.round(Number(amountGnf) * VIRTUAL_CARD_TOPUP_FEE_RATE);
  if (feeAmount > 0) {
    const feesWallet = await walletService.getOrCreateSystemWallet('FEES_COLLECTED');
    await walletService.moveFunds({
      fromWalletId: cardProviderWallet.id,
      toWalletId: feesWallet.id,
      amount: feeAmount,
      type: 'FEE',
      idempotencyKey: `${idempotencyKey}:fee`,
      initiatedByUserId: userId,
      metadata: { relatedTransactionId: topupTx.id },
    });
  }

  // Conversion GNF -> USD (devise carte) - taux approximatif documenté
  // dans config/exchangeRates.js, à remplacer par un flux de change réel
  // une fois un vrai fournisseur de carte intégré. Jamais un 1:1 arbitraire.
  const amountInCardCurrency = gnfToUsd(Number(amountGnf) - feeAmount);

  const result = await provider.topUp(card.providerCardId, amountInCardCurrency);
  if (!result.success) {
    throw new VirtualCardError('Échec du rechargement chez le fournisseur de carte', 502);
  }

  const updated = await prisma.virtualCard.update({
    where: { id: card.id },
    data: { balance: { increment: amountInCardCurrency } },
  });

  await notifyUser(userId, {
    type: 'VIRTUAL_CARD_TOPUP',
    title: 'Carte rechargée',
    body: `Rechargement de ${Number(amountGnf).toLocaleString('fr-FR')} GNF sur votre carte virtuelle`,
    data: { transactionId: topupTx.id },
  });

  return { card: withGnfEquivalent(updated), feeAmount, transactionId: topupTx.id };
}

// --- Gel / dégel / fermeture -------------------------------------------------

async function freezeCard(userId) {
  const card = await getMyCard(userId);
  await provider.freeze(card.providerCardId);
  const updated = await prisma.virtualCard.update({ where: { id: card.id }, data: { status: 'FROZEN' } });

  await notifyUser(userId, {
    type: 'VIRTUAL_CARD_FROZEN',
    title: 'Carte gelée',
    body: 'Votre carte virtuelle a été gelée. Aucune transaction ne peut être effectuée tant qu\'elle est gelée.',
  });

  return withGnfEquivalent(updated);
}

async function unfreezeCard(userId) {
  const card = await getMyCard(userId);
  await provider.unfreeze(card.providerCardId);
  const updated = await prisma.virtualCard.update({ where: { id: card.id }, data: { status: 'ACTIVE' } });

  await notifyUser(userId, {
    type: 'VIRTUAL_CARD_UNFROZEN',
    title: 'Carte dégelée',
    body: 'Votre carte virtuelle est de nouveau active.',
  });

  return withGnfEquivalent(updated);
}

module.exports = {
  VirtualCardError,
  issueCard,
  getMyCard,
  topUp,
  freezeCard,
  unfreezeCard,
  revealDetails,
};

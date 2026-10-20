const prisma = require('../../config/db');
const { getLimitsForUser } = require('../../config/limits');

class LimitExceededError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 403;
  }
}

// Vérifie qu'une transaction de `amount` GNF respecte les 3 plafonds
// (par transaction, par jour, par mois) du profil de l'utilisateur.
// À appeler AVANT toute écriture au ledger, jamais après.
async function assertWithinLimits(userId, amount) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { kycProfile: true, businessProfile: true },
  });

  const limits = getLimitsForUser(user);
  const amountNum = Number(amount);

  if (amountNum > limits.perTransaction) {
    throw new LimitExceededError(
      `Montant supérieur au plafond par transaction (${limits.perTransaction.toLocaleString('fr-FR')} GNF)`
    );
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return; // pas encore de wallet = pas d'historique à sommer

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dailyTotal, monthlyTotal] = await Promise.all([
    sumDebitsSince(wallet.id, startOfDay),
    sumDebitsSince(wallet.id, startOfMonth),
  ]);

  if (dailyTotal + amountNum > limits.daily) {
    throw new LimitExceededError(
      `Plafond journalier dépassé (${limits.daily.toLocaleString('fr-FR')} GNF/jour)`
    );
  }

  if (monthlyTotal + amountNum > limits.monthly) {
    throw new LimitExceededError(
      `Plafond mensuel dépassé (${limits.monthly.toLocaleString('fr-FR')} GNF/mois)`
    );
  }
}

async function sumDebitsSince(walletId, since) {
  const result = await prisma.ledgerEntry.aggregate({
    where: { walletId, direction: 'DEBIT', createdAt: { gte: since } },
    _sum: { amount: true },
  });
  return Number(result._sum.amount || 0);
}

module.exports = { assertWithinLimits, LimitExceededError };

const prisma = require('../../config/db');

// Le contrôle le plus important du système financier : le solde mis en
// cache sur Wallet.balance doit TOUJOURS être égal à la somme des
// LedgerEntry de ce wallet (crédits moins débits). Si les deux divergent,
// c'est soit un bug dans moveFunds(), soit une écriture directe en base
// qui a contourné le service - dans les deux cas, une urgence à traiter
// avant qu'un utilisateur ou un régulateur ne le remarque avant nous.
//
// Une seule requête SQL agrégée plutôt qu'une boucle JS par wallet : à
// l'échelle (des dizaines de milliers de wallets), la différence de
// performance est énorme, et c'est un job qui doit pouvoir tourner
// chaque nuit sans ralentir la base.
async function findBalanceDiscrepancies() {
  const rows = await prisma.$queryRaw`
    SELECT
      w.id AS "walletId",
      w."ownerType" AS "ownerType",
      w."userId" AS "userId",
      w.balance AS "cachedBalance",
      COALESCE(SUM(
        CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END
      ), 0) AS "ledgerBalance"
    FROM "Wallet" w
    LEFT JOIN "LedgerEntry" le ON le."walletId" = w.id
    GROUP BY w.id, w."ownerType", w."userId", w.balance
    HAVING w.balance <> COALESCE(SUM(
      CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END
    ), 0)
  `;

  return rows.map((row) => ({
    walletId: row.walletId,
    ownerType: row.ownerType,
    userId: row.userId,
    cachedBalance: Number(row.cachedBalance),
    ledgerBalance: Number(row.ledgerBalance),
    drift: Number(row.cachedBalance) - Number(row.ledgerBalance),
  }));
}

// Contrôle complémentaire : chaque Transaction doit avoir exactement 2
// LedgerEntry (jamais 0, jamais 1, jamais 3+) dont la somme signée vaut
// zéro. Une transaction avec un nombre d'écritures différent de 2 est un
// signe de bug direct dans moveFunds() ou d'une écriture manuelle
// malvenue en base.
async function findUnbalancedTransactions() {
  const rows = await prisma.$queryRaw`
    SELECT
      t.id AS "transactionId",
      t.type AS "type",
      COUNT(le.id)::int AS "entryCount",
      COALESCE(SUM(
        CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END
      ), 0) AS "netAmount"
    FROM "Transaction" t
    LEFT JOIN "LedgerEntry" le ON le."transactionId" = t.id
    WHERE t.status = 'COMPLETED'
    GROUP BY t.id, t.type
    HAVING COUNT(le.id) != 2
        OR COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END), 0) != 0
  `;

  return rows.map((row) => ({
    transactionId: row.transactionId,
    type: row.type,
    entryCount: row.entryCount,
    netAmount: Number(row.netAmount),
  }));
}

async function runReconciliation() {
  const [balanceDiscrepancies, unbalancedTransactions] = await Promise.all([
    findBalanceDiscrepancies(),
    findUnbalancedTransactions(),
  ]);

  return {
    ranAt: new Date().toISOString(),
    healthy: balanceDiscrepancies.length === 0 && unbalancedTransactions.length === 0,
    balanceDiscrepancies,
    unbalancedTransactions,
  };
}

module.exports = { findBalanceDiscrepancies, findUnbalancedTransactions, runReconciliation };

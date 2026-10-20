// Usage : node scripts/reconcile.js
//
// À programmer via cron chaque nuit (ex: 0 3 * * * dans le crontab du
// serveur). Sort avec un code de sortie non-nul si une divergence est
// détectée, pour qu'une alerte automatique (monitoring, Slack, email)
// puisse se déclencher sans intervention humaine pour la détecter.

require('dotenv').config();
const prisma = require('../src/config/db');
const { runReconciliation } = require('../src/modules/wallet/reconciliation.service');

async function main() {
  const report = await runReconciliation();

  console.log(`[reconcile] ${report.ranAt}`);

  if (report.healthy) {
    console.log('[reconcile] OK - aucune divergence détectée.');
    return;
  }

  console.error(`[reconcile] ALERTE - ${report.balanceDiscrepancies.length} solde(s) divergent(s), ${report.unbalancedTransactions.length} transaction(s) déséquilibrée(s)`);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[reconcile] Erreur inattendue :', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

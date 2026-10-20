// Usage : node scripts/run-per-diem.js
//
// À programmer via cron à intervalle rapproché (ex: */5 * * * * - toutes
// les 5 minutes, ou */1 * * * * pour une précision à la minute) : exécute
// chaque automatisation "paiement automatique du personnel" (per diem)
// dont le créneau programmé est passé depuis le dernier passage. Même
// principe que retry-webhooks.js - un script autonome, jamais déclenché
// depuis une route HTTP classique (aucun humain présent à l'heure
// programmée pour taper un code de confirmation).
require('dotenv').config();
const prisma = require('../src/config/db');
const { runDueSchedules } = require('../src/modules/perDiem/perDiem.service');

async function main() {
  const results = await runDueSchedules();
  const okCount = results.filter((r) => r.ok).length;
  console.log(`[run-per-diem] ${new Date().toISOString()} - ${results.length} automatisation(s) exécutée(s), ${okCount} réussie(s)`);
  for (const r of results.filter((r) => !r.ok)) {
    console.error(`[run-per-diem] échec pour l'entreprise ${r.businessUserId} : ${r.error}`);
  }
}

main()
  .catch((err) => {
    console.error('[run-per-diem] Erreur inattendue :', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

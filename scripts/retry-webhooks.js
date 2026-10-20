// Usage : node scripts/retry-webhooks.js
//
// À programmer via cron à intervalle rapproché (ex: */5 * * * * - toutes
// les 5 minutes) : retente chaque livraison de webhook encore en attente
// dont l'heure de réessai (backoff croissant) est passée. Corrige la
// limite documentée à l'origine dans webhook.service.js - un échec de
// livraison n'est plus définitivement perdu.

require('dotenv').config();
const prisma = require('../src/config/db');
const { retryPendingWebhookDeliveries } = require('../src/modules/payments/webhook.service');

async function main() {
  const result = await retryPendingWebhookDeliveries();
  console.log(`[retry-webhooks] ${new Date().toISOString()} - ${result.checked} livraison(s) réessayée(s)`);
}

main()
  .catch((err) => {
    console.error('[retry-webhooks] Erreur inattendue :', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

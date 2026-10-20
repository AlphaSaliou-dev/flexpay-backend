const crypto = require('crypto');
const prisma = require('../../config/db');
const { logger } = require('../../utils/logger');
const { parsePagination, buildPaginatedResult } = require('../../utils/pagination');
const { decrypt } = require('../../utils/encryption');

const DELIVERY_TIMEOUT_MS = 5000;

// Backoff croissant en secondes : 1 min, 5 min, 30 min, 2 h. Après le
// dernier essai (5 tentatives au total, la première étant immédiate), la
// livraison est abandonnée mais reste consultable par le partenaire
// (GET /payments/api/webhook-deliveries) plutôt que silencieusement perdue.
const WEBHOOK_RETRY_DELAYS_SEC = [60, 300, 1800, 7200];
const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SEC.length + 1;

function computeSignature(secret, payloadString) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

// Une seule tentative HTTP - jamais d'exception qui remonte, toujours un
// booléen de résultat + message d'erreur éventuel. Réutilisé à la fois
// pour l'essai immédiat et pour chaque réessai différé.
async function attemptDelivery(apiClient, event, payloadString, signature) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
      const res = await fetch(apiClient.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FlexPay-Signature': `sha256=${signature}`,
          'X-FlexPay-Event': event,
        },
        body: payloadString,
        signal: controller.signal,
      });
      // Un 2xx est un succès ; tout le reste (4xx/5xx côté partenaire)
      // est traité comme un échec à réessayer, pas différent d'un timeout.
      if (res.ok) return { success: true };
      return { success: false, error: `HTTP ${res.status}` };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Envoie un webhook si (et seulement si) le partenaire a configuré une
// URL. Ne lève JAMAIS d'exception - un webhook qui échoue ne doit jamais
// faire échouer l'action réelle qui l'a déclenché. Fire-and-forget côté
// appelant (jamais attendu avec un await bloquant sur le chemin
// critique). Chaque tentative est désormais journalisée dans
// WebhookDelivery, et un échec programme un réessai automatique - voir
// retryPendingWebhookDeliveries(), à appeler périodiquement (cron, voir
// scripts/retry-webhooks.js).
async function deliverWebhook(apiClient, event, data) {
  if (!apiClient.webhookUrl || !apiClient.webhookSecret) return;

  const payload = { event, data, timestamp: new Date().toISOString() };
  const payloadString = JSON.stringify(payload);
  const signature = computeSignature(decrypt(apiClient.webhookSecret), payloadString);

  const delivery = await prisma.webhookDelivery.create({
    data: { apiClientId: apiClient.id, event, payload, status: 'PENDING', attempts: 0 },
  });

  const result = await attemptDelivery(apiClient, event, payloadString, signature);
  await recordAttemptResult(delivery, result);
}

// Centralise la mise à jour d'une WebhookDelivery après une tentative
// (initiale ou réessai) - même logique de backoff/abandon dans les deux cas.
async function recordAttemptResult(delivery, result) {
  const attempts = delivery.attempts + 1;

  if (result.success) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', attempts, deliveredAt: new Date(), lastError: null, nextRetryAt: null },
    });
    return;
  }

  logger.warn(
    { deliveryId: delivery.id, attempts, error: result.error },
    '[webhook] échec de livraison'
  );

  if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', attempts, lastError: result.error, nextRetryAt: null },
    });
    return;
  }

  const delaySec = WEBHOOK_RETRY_DELAYS_SEC[attempts - 1];
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'PENDING',
      attempts,
      lastError: result.error,
      nextRetryAt: new Date(Date.now() + delaySec * 1000),
    },
  });
}

// À appeler périodiquement (cron - voir scripts/retry-webhooks.js) : relit
// chaque tentative encore en attente et dont l'heure de réessai est
// passée, puis retente exactement comme au premier envoi (même
// signature, recalculée à partir du payload et du secret ENCORE valides
// au moment du réessai - si le partenaire régénère son secret entre
// temps, les réessais suivants échoueront et finiront par être abandonnés,
// ce qui est le comportement voulu plutôt qu'un signal silencieusement faux).
async function retryPendingWebhookDeliveries() {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextRetryAt: { lte: new Date() } },
    include: { apiClient: true },
  });

  let retried = 0;
  for (const delivery of due) {
    if (!delivery.apiClient.webhookUrl || !delivery.apiClient.webhookSecret) {
      // URL/secret retirés depuis - plus rien à réessayer, on abandonne proprement.
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', lastError: 'Webhook non configuré au moment du réessai', nextRetryAt: null },
      });
      continue;
    }

    const payloadString = JSON.stringify(delivery.payload);
    const signature = computeSignature(decrypt(delivery.apiClient.webhookSecret), payloadString);
    const result = await attemptDelivery(delivery.apiClient, delivery.event, payloadString, signature);
    await recordAttemptResult(delivery, result);
    retried += 1;
  }

  return { checked: due.length, retried };
}

// Visibilité partenaire : sans ça, un partenaire dont un webhook échoue
// n'a aucun moyen de savoir si c'est arrivé, combien de fois FlexPay a
// réessayé, ni pourquoi - juste un silence radio, ou GET /api/intents/:id
// en filet de sécurité manuel.
async function listDeliveriesForApiClient(apiClient, { status, page, pageSize } = {}) {
  const { skip, take } = parsePagination({ page, pageSize });
  const where = { apiClientId: apiClient.id, ...(status ? { status } : {}) };

  const [items, total] = await Promise.all([
    prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.webhookDelivery.count({ where }),
  ]);

  return buildPaginatedResult(items, total, Math.max(1, parseInt(page, 10) || 1), take);
}

module.exports = {
  deliverWebhook,
  computeSignature,
  retryPendingWebhookDeliveries,
  listDeliveriesForApiClient,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SEC,
};

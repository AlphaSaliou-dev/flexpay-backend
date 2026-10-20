const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { requireApiKey } = require('./requireApiKey');
const { apiPartnerLimiter } = require('../../middlewares/rateLimiter');
const { payMerchantSchema, setWebhookUrlSchema, setEnabledExternalMethodsSchema } = require('./payments.validation');
const { createIntentSchema, approveIntentSchema, testResolveIntentSchema, collectIntentExternalSchema } = require('./paymentIntent.validation');
const { createFieldSchema, updateFieldSchema, receiptBrandingSchema } = require('./payments.validation');
const { createPayoutSchema } = require('./apiPayout.validation');
const paymentsController = require('./payments.controller');
const intentController = require('./paymentIntent.controller');
const payoutController = require('./apiPayout.controller');
const webhookDeliveryController = require('./webhookDelivery.controller');
const fieldsController = require('./businessPaymentFields.controller');

const router = express.Router();

// --- In-app : un utilisateur connecté paie directement un compte Business ---
router.post(
  '/pay',
  requireAuth,
  validate(payMerchantSchema),
  requireTransactionPin,
  paymentsController.payMerchant
);

// --- API B2B : appels serveur-à-serveur d'un partenaire (MarketConnect...) ---
router.post('/api/intents', requireApiKey, apiPartnerLimiter, validate(createIntentSchema), intentController.createIntent);
router.get('/api/intents', requireApiKey, apiPartnerLimiter, intentController.listIntents);
router.get('/api/intents/:id', requireApiKey, apiPartnerLimiter, intentController.getIntentStatus);
router.post('/api/intents/:id/cancel', requireApiKey, apiPartnerLimiter, intentController.cancelIntent);
router.post('/api/intents/:id/test-resolve', requireApiKey, apiPartnerLimiter, validate(testResolveIntentSchema), intentController.testResolveIntent);

// Résolution pour un client final sans compte FlexPay (Orange Money, MTN,
// carte) - appelée par le partenaire une fois le moyen choisi dans SON
// propre checkout. Le moyen doit figurer dans enabledExternalMethods de
// cette clé (vérifié dans le service), jamais FlexPay ici : FlexPay se
// résout toujours via /intents/:id/approve, côté app.
router.post(
  '/api/intents/:id/collect-external',
  requireApiKey,
  apiPartnerLimiter,
  validate(collectIntentExternalSchema),
  intentController.collectExternal
);

// --- API B2B pay-out : le partenaire pousse de l'argent VERS un utilisateur
// (rembourser un client, payer un livreur...) - symétrique du pay-in
// ci-dessus, sans étape d'approbation (recevoir ne se confirme jamais). ---
router.post('/api/payouts', requireApiKey, apiPartnerLimiter, validate(createPayoutSchema), payoutController.createPayout);
router.get('/api/payouts', requireApiKey, apiPartnerLimiter, payoutController.listPayouts);
router.get('/api/payouts/:id', requireApiKey, apiPartnerLimiter, payoutController.getPayoutStatus);

// --- Historique de livraison des webhooks (visibilité partenaire) ---
router.get('/api/webhook-deliveries', requireApiKey, apiPartnerLimiter, webhookDeliveryController.list);

// --- Côté app : l'utilisateur voit et approuve les demandes en attente ---
router.get('/intents/pending', requireAuth, intentController.listPending);
router.post('/intents/:id/approve', requireAuth, validate(approveIntentSchema), requireTransactionPin, intentController.approve);
router.post('/intents/:id/reject', requireAuth, intentController.reject);

// --- Statut de la clé API du compte Business connecté (lecture seule) ---
router.get('/api-status', requireAuth, paymentsController.getMyApiClientStatus);

// --- Clé de test en libre-service (aucun risque financier - jamais de vrai argent) ---
router.post('/api-clients/self-service-test-key', requireAuth, paymentsController.requestTestApiKey);

// --- Régénération de la clé API elle-même (perdue, ou par précaution) ---
router.post('/api-clients/:id/regenerate-key', requireAuth, paymentsController.regenerateApiKey);

// --- Configuration webhook (propriété vérifiée dans le service) ---
router.put('/api-clients/:id/webhook', requireAuth, validate(setWebhookUrlSchema), paymentsController.setWebhookUrl);
router.post('/api-clients/:id/webhook/regenerate-secret', requireAuth, paymentsController.regenerateWebhookSecret);

// --- Moyens de paiement externes activés par le partenaire dans son
// propre checkout (FlexPay reste toujours disponible à part, jamais dans
// cette liste - voir setEnabledExternalMethodsSchema) ---
router.put(
  '/api-clients/:id/payment-methods',
  requireAuth,
  validate(setEnabledExternalMethodsSchema),
  paymentsController.setEnabledExternalMethods
);

// --- Champs de paiement personnalisés (gestion par l'institution elle-même) ---
router.get('/business-fields', requireAuth, fieldsController.list);
router.post('/business-fields', requireAuth, validate(createFieldSchema), fieldsController.create);
router.put('/business-fields/:id', requireAuth, validate(updateFieldSchema), fieldsController.update);
router.delete('/business-fields/:id', requireAuth, fieldsController.remove);

// --- Personnalisation du reçu (logo + pied de page) ---
router.get('/receipt-branding', requireAuth, paymentsController.getReceiptBranding);
router.put('/receipt-branding', requireAuth, validate(receiptBrandingSchema), paymentsController.setReceiptBranding);

// --- Reçu PDF : deux routes distinctes, une pour obtenir le lien
// (toujours authentifiée classiquement), une pour l'ouvrir (accepte le
// token à portée limitée en paramètre d'URL - voir payments.controller.js) ---
router.post('/receipts/:transactionId/download-link', requireAuth, paymentsController.getReceiptDownloadLink);
router.get('/receipts/:transactionId/verify', paymentsController.verifyReceipt);
router.get('/receipts/:transactionId', paymentsController.downloadReceipt);

// --- Tableau de bord "Paiements reçus" pour une institution ---
router.get('/received', requireAuth, paymentsController.listReceivedPayments);
router.get('/received/summary', requireAuth, paymentsController.getReceivedPaymentsSummary);

module.exports = router;

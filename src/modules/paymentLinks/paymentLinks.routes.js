const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { mobileMoneyPayLimiter } = require('../../middlewares/rateLimiter');
const { createPaymentLinkSchema, toggleActiveSchema, payViaLinkSchema, payViaLinkMobileMoneySchema } = require('./paymentLinks.validation');
const controller = require('./paymentLinks.controller');

const router = express.Router();

// --- Gestion par le marchand (compte Business validé KYB) ---
router.post('/', requireAuth, validate(createPaymentLinkSchema), controller.create);
router.get('/', requireAuth, controller.list);
router.post('/:id/toggle', requireAuth, validate(toggleActiveSchema), controller.toggle);
router.post('/:id/reactivate', requireAuth, controller.reactivate);

// --- Côté payeur : consultation publique (avant connexion), puis paiement ---
// une fois connecté, avec le même flux OTP en 2 temps que "payer un
// marchand" - un lien de paiement reste une action qui fait sortir de
// l'argent du wallet du payeur.
router.get('/public/:code', controller.getPublic);
router.post('/public/:code/pay', requireAuth, validate(payViaLinkSchema), requireTransactionPin, controller.pay);

// --- Paiement invité par Mobile Money (Orange Money, MTN) : aucun compte
// FlexPay requis, voir payViaLinkMobileMoney. Limité par IP (pas d'OTP ni
// de session à adosser à une limite par utilisateur ici). ---
router.post(
  '/public/:code/pay-mobile-money',
  mobileMoneyPayLimiter,
  validate(payViaLinkMobileMoneySchema),
  controller.payMobileMoney
);

module.exports = router;

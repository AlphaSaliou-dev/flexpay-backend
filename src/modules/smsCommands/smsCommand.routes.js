const express = require('express');
const { requireSmsWebhookSecret } = require('./requireSmsWebhookSecret');
const { smsInboundLimiter } = require('../../middlewares/rateLimiter');
const controller = require('./smsCommand.controller');

const router = express.Router();

// Appelé par le fournisseur SMS (Nimba SMS) à chaque SMS reçu sur le
// numéro FlexPay - voir requireSmsWebhookSecret pour l'authentification
// et smsCommand.service.js pour le détail des commandes (OTP, SOLDE,
// DEPOT, RETRAIT, ENVOI). Forme de payload assumée en l'absence d'un
// vrai partenaire branché : { from, text, messageId? } - à ajuster une
// fois le format réel de Nimba SMS connu.
router.post('/inbound', smsInboundLimiter, requireSmsWebhookSecret, controller.inbound);

module.exports = router;

const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { recipientLookupLimiter } = require('../../middlewares/rateLimiter');
const { depositSchema, withdrawSchema, transferSchema } = require('./wallet.validation');
const controller = require('./wallet.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/balance', controller.getBalance);
router.get('/history', controller.getHistory);
router.get('/statement.csv', controller.getStatementCsv);
router.get('/statement.pdf', controller.getStatementPdf);
router.get('/recipient-lookup', recipientLookupLimiter, controller.lookupRecipient);

// Le dépôt n'exige pas d'OTP sensible (argent qui entre = faible risque).
router.post('/deposit', validate(depositSchema), controller.deposit);

// Retrait et transfert : argent qui SORT du compte -> code PIN obligatoire.
router.post('/withdraw', validate(withdrawSchema), requireTransactionPin, controller.withdraw);
router.post('/transfer', validate(transferSchema), requireTransactionPin, controller.transfer);

module.exports = router;

const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { topUpSchema } = require('./virtualCard.validation');
const controller = require('./virtualCard.controller');

const router = express.Router();

router.use(requireAuth);

router.post('/', controller.issueCard); // création - pas de montant en jeu, pas de PIN requis
router.get('/', controller.getMyCard);
router.post('/topup', validate(topUpSchema), requireTransactionPin, controller.topUp);
router.post('/freeze', controller.freeze); // geler est toujours sûr, jamais bloqué par PIN
router.post('/unfreeze', requireTransactionPin, controller.unfreeze); // redonne la capacité de dépenser -> PIN requis
router.post('/reveal', requireTransactionPin, controller.reveal); // numéro complet + CVC -> PIN requis

module.exports = router;

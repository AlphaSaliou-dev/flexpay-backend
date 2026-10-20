const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { createBulkPayoutSchema, retryBulkPayoutSchema } = require('./bulkPayout.validation');
const { groupSchema } = require('./beneficiaryGroups.validation');
const controller = require('./bulkPayout.controller');
const groupsController = require('./beneficiaryGroups.controller');

const router = express.Router();

router.use(requireAuth);

// --- Listes de bénéficiaires sauvegardées -----------------------------------
// Montées AVANT /:id : sinon Express interpréterait "groups" comme un
// identifiant de lot et ces routes ne seraient jamais atteintes.
router.post('/groups', validate(groupSchema), groupsController.create);
router.get('/groups', groupsController.list);
router.get('/groups/:id', groupsController.getOne);
router.put('/groups/:id', validate(groupSchema), groupsController.update);
router.delete('/groups/:id', groupsController.remove);

router.post('/', validate(createBulkPayoutSchema), requireTransactionPin, controller.create);
router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/:id/retry', validate(retryBulkPayoutSchema), requireTransactionPin, controller.retry);

module.exports = router;

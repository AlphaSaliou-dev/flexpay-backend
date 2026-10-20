const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const {
  submitTier1Schema,
  submitTier2Schema,
  submitBusinessKycSchema,
  submitMerchantKycSchema,
} = require('./kyc.validation');
const controller = require('./kyc.controller');

const router = express.Router();

// Tout le module KYC nécessite d'être connecté.
router.use(requireAuth);

router.get('/status', controller.getStatus);
router.post('/tier1', validate(submitTier1Schema), controller.submitTier1);
router.post('/tier2', validate(submitTier2Schema), controller.submitTier2);
router.post('/business', validate(submitBusinessKycSchema), controller.submitBusinessKyc);
router.post('/merchant', validate(submitMerchantKycSchema), controller.submitMerchantKyc);

// Les routes de revue (approbation/rejet) seront ajoutées avec le futur
// module admin/back-office - elles ne doivent jamais être accessibles
// depuis l'app grand public.

module.exports = router;

const kycService = require('./kyc.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof kycService.KycError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('kyc', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const getStatus = handle((req) => kycService.getMyKycStatus(req.user.id));
const submitTier1 = handle((req) => kycService.submitTier1(req.user.id, req.body));
const submitTier2 = handle((req) => kycService.submitTier2(req.user.id, req.body));
const submitBusinessKyc = handle((req) => kycService.submitBusinessKyc(req.user.id, req.body));
const submitMerchantKyc = handle((req) => kycService.submitMerchantKyc(req.user.id, req.body));

module.exports = { getStatus, submitTier1, submitTier2, submitBusinessKyc, submitMerchantKyc };

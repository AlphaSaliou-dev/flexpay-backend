const payoutService = require('./apiPayout.service');
const { logError } = require('../../utils/logger');
const { PaymentError } = require('./payments.service');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PaymentError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('api-payout', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const createPayout = handle((req) => payoutService.createPayout(req.apiClient, req.body));
const getPayoutStatus = handle((req) => payoutService.getPayoutStatus(req.apiClient, req.params.id));
const listPayouts = handle((req) => payoutService.listPayoutsForApiClient(req.apiClient, req.query));

module.exports = { createPayout, getPayoutStatus, listPayouts };

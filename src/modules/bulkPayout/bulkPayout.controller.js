const bulkPayoutService = require('./bulkPayout.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof bulkPayoutService.BulkPayoutError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('bulk-payout', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const create = handle((req) => bulkPayoutService.createBulkPayout(req.user.id, req.body));
const getOne = handle((req) => bulkPayoutService.getBulkPayoutSummaryForBusiness(req.user.id, req.params.id));
const retry = handle((req) => bulkPayoutService.retryFailedItems(req.user.id, req.params.id, req.body));
const list = handle((req) => bulkPayoutService.listBulkPayoutsForBusiness(req.user.id));

module.exports = { create, getOne, retry, list };

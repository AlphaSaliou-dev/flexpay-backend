const intentService = require('./paymentIntent.service');
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
      logError('payment-intent', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

// --- Côté partenaire (clé API) ---
const createIntent = handle((req) => intentService.createIntent(req.apiClient, req.body));
const getIntentStatus = handle((req) => intentService.getIntentStatus(req.apiClient, req.params.id));
const testResolveIntent = handle((req) => intentService.testResolveIntent(req.apiClient, req.params.id, req.body.outcome));
const listIntents = handle((req) => intentService.listIntentsForApiClient(req.apiClient, req.query));
const cancelIntent = handle((req) => intentService.cancelIntent(req.apiClient, req.params.id));
const collectExternal = handle((req) => intentService.collectIntentExternally(req.apiClient, req.params.id, req.body));

// --- Côté utilisateur (app FlexPay) ---
const listPending = handle((req) => intentService.listPendingIntentsForUser(req.user.id));
const approve = handle((req) => intentService.approveIntent(req.user.id, req.params.id));
const reject = handle((req) => intentService.rejectIntent(req.user.id, req.params.id));

module.exports = {
  createIntent,
  getIntentStatus,
  testResolveIntent,
  listIntents,
  cancelIntent,
  collectExternal,
  listPending,
  approve,
  reject,
};

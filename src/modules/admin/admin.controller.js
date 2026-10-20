const adminAuthService = require('./adminAuth.service');
const { logError } = require('../../utils/logger');
const adminService = require('./admin.service');
const { RefundError } = require('../wallet/refund.service');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof adminAuthService.AdminAuthError || err instanceof adminService.AdminError || err instanceof RefundError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('admin', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const login = handle((req) => adminAuthService.login(req.body));
const confirmTotpSetup = handle((req) => adminAuthService.confirmTotpSetup(req.body.pendingToken, req.body.code));
const verifyTotp = handle((req) => adminAuthService.verifyTotp(req.body.pendingToken, req.body.code));

const listPendingKyc = handle((req) => adminService.listPendingKyc(req.query));
const reviewKyc = handle((req) => adminService.reviewKyc(req.admin.id, req.params.userId, req.body));

const listPendingKyb = handle((req) => adminService.listPendingKyb(req.query));
const reviewKyb = handle((req) => adminService.reviewKyb(req.admin.id, req.params.userId, req.body));

const createApiClient = handle((req) => adminService.createApiClient(req.body));
const listApiClients = handle(() => adminService.listApiClients());
const revokeApiClient = handle((req) => adminService.revokeApiClient(req.params.id));

const listSuspiciousFanIn = handle(() => adminService.listSuspiciousFanIn());
const listStructuringPatterns = handle(() => adminService.listStructuringPatterns());
const dismissRiskAlert = handle((req) => adminService.dismissRiskAlert(req.admin.id, req.body));

const listWatchlist = handle(() => adminService.listWatchlist());
const addToWatchlist = handle((req) => adminService.addToWatchlist(req.body));
const removeFromWatchlist = handle((req) => adminService.removeFromWatchlist(req.params.id));

const listAuditLog = handle((req) => adminService.listAuditLog(req.query));
const searchUsers = handle((req) => adminService.searchUsers(req.query.q));
const getUserDetail = handle((req) => adminService.getUserDetail(req.params.userId));
const resendVerificationOtp = handle((req) => adminService.resendVerificationOtp(req.params.userId));
const listAllPaymentFields = handle((req) => adminService.listAllPaymentFields(req.query));
const forceDeletePaymentField = handle((req) => adminService.forceDeletePaymentField(req.admin.id, req.params.id));
const getBusinessMetrics = handle((req) => adminService.getBusinessMetrics({ days: req.query.days ? Number(req.query.days) : undefined }));

const refundService = require('../wallet/refund.service');
const reconciliationService = require('../wallet/reconciliation.service');
const webhookService = require('../payments/webhook.service');

const refundTransaction = handle((req) =>
  refundService.refundTransaction(req.admin.id, req.params.transactionId, req.body.reason)
);
const runReconciliation = handle(() => reconciliationService.runReconciliation());
const retryWebhooks = handle(() => webhookService.retryPendingWebhookDeliveries());

module.exports = {
  login,
  confirmTotpSetup,
  verifyTotp,
  listPendingKyc,
  reviewKyc,
  listPendingKyb,
  reviewKyb,
  createApiClient,
  listApiClients,
  revokeApiClient,
  listSuspiciousFanIn,
  listStructuringPatterns,
  dismissRiskAlert,
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  refundTransaction,
  runReconciliation,
  retryWebhooks,
  listAuditLog,
  searchUsers,
  getUserDetail,
  resendVerificationOtp,
  listAllPaymentFields,
  forceDeletePaymentField,
  getBusinessMetrics,
};

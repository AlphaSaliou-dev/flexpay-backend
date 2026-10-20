const express = require('express');
const { validate } = require('../../middlewares/validate');
const { loginLimiter } = require('../../middlewares/rateLimiter');
const { requireAdminAuth, requireRole } = require('./requireAdminAuth');
const {
  adminLoginSchema,
  totpCodeSchema,
  reviewSchema,
  createApiClientSchema,
} = require('./admin.validation');
const controller = require('./admin.controller');
const filesController = require('../files/files.controller');

const router = express.Router();

router.post('/login', loginLimiter, validate(adminLoginSchema), controller.login);
router.post('/2fa/setup/confirm', loginLimiter, validate(totpCodeSchema), controller.confirmTotpSetup);
router.post('/2fa/verify', loginLimiter, validate(totpCodeSchema), controller.verifyTotp);

router.use(requireAdminAuth); // tout ce qui suit exige d'être connecté en admin

// --- KYC / KYB : rôle COMPLIANCE ou SUPERADMIN ---
router.get('/kyc/pending', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listPendingKyc);
router.post('/kyc/:userId/review', requireRole('COMPLIANCE', 'SUPERADMIN'), validate(reviewSchema), controller.reviewKyc);

router.get('/kyb/pending', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listPendingKyb);
router.post('/kyb/:userId/review', requireRole('COMPLIANCE', 'SUPERADMIN'), validate(reviewSchema), controller.reviewKyb);

// Consultation des pièces jointes (ID, documents Business) pendant la revue.
router.get('/files/:id', requireRole('COMPLIANCE', 'SUPERADMIN'), filesController.getFileAsAdmin);

// --- Partenaires API : SUPERADMIN uniquement (créer une clé = pouvoir financier réel) ---
router.post('/api-clients', requireRole('SUPERADMIN'), validate(createApiClientSchema), controller.createApiClient);
router.get('/api-clients', requireRole('SUPERADMIN', 'COMPLIANCE'), controller.listApiClients);
router.post('/api-clients/:id/revoke', requireRole('SUPERADMIN'), controller.revokeApiClient);

// --- Détection risque : comptes Particulier au comportement commercial ---
router.get('/risk/fan-in', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listSuspiciousFanIn);
router.get('/risk/structuring', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listStructuringPatterns);
router.post('/risk/dismiss', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.dismissRiskAlert);

// --- Liste de vigilance (sanctions/PEP) ---
router.get('/watchlist', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listWatchlist);
router.post('/watchlist', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.addToWatchlist);
router.delete('/watchlist/:id', requireRole('SUPERADMIN'), controller.removeFromWatchlist);

// --- Remboursements : COMPLIANCE ou SUPERADMIN, jamais en self-service utilisateur ---
router.post('/refunds/:transactionId', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.refundTransaction);

// --- Réconciliation à la demande (en plus du job cron nocturne, scripts/reconcile.js) ---
router.get('/reconciliation', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.runReconciliation);

// --- Réessai des webhooks en attente à la demande (en plus du job cron, scripts/retry-webhooks.js) ---
router.post('/webhooks/retry', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.retryWebhooks);

// --- Journal d'audit : COMPLIANCE et SUPERADMIN uniquement (vue transverse sur tous les comptes) ---
router.get('/audit-log', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listAuditLog);

// --- Actions SUPPORT : lecture seule, aucun mouvement d'argent ni décision KYC ---
router.get('/users/search', requireRole('SUPPORT', 'COMPLIANCE', 'SUPERADMIN'), controller.searchUsers);
router.get('/users/:userId', requireRole('SUPPORT', 'COMPLIANCE', 'SUPERADMIN'), controller.getUserDetail);
router.post('/users/:userId/resend-otp', requireRole('SUPPORT', 'COMPLIANCE', 'SUPERADMIN'), controller.resendVerificationOtp);

// --- Modération des champs de paiement personnalisés ---
router.get('/payment-fields', requireRole('COMPLIANCE', 'SUPERADMIN'), controller.listAllPaymentFields);
router.delete('/payment-fields/:id', requireRole('SUPERADMIN'), controller.forceDeletePaymentField);

// --- Tableau de bord interne (métriques business, données sensibles - SUPERADMIN uniquement) ---
router.get('/metrics', requireRole('SUPERADMIN'), controller.getBusinessMetrics);

module.exports = router;

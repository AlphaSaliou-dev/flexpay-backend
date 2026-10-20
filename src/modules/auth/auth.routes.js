const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { loginLimiter, otpRequestLimiter } = require('../../middlewares/rateLimiter');
const { requireSensitiveOtp } = require('./requireSensitiveOtp');
const {
  registerSchema,
  verifyOtpSchema,
  resendOtpSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  setTransactionPinSchema,
} = require('./auth.validation');
const controller = require('./auth.controller');

const router = express.Router();

router.post('/register', otpRequestLimiter, validate(registerSchema), controller.register);
router.post('/resend-otp', otpRequestLimiter, validate(resendOtpSchema), controller.resendOtp);
router.post('/verify-otp', validate(verifyOtpSchema), controller.verifyOtp);
router.post('/login', loginLimiter, validate(loginSchema), controller.login);
router.post('/refresh', validate(refreshSchema), controller.refresh);

// Étape 1 du flux "action sensible" : demander le code, une fois connecté.
// Étape 2 (vérification) se fait via le middleware requireSensitiveOtp,
// directement sur la route de l'action elle-même (ex: futur /wallet/withdraw).
router.post('/sensitive-otp/request', requireAuth, otpRequestLimiter, controller.requestSensitiveOtp);

// Changement de mot de passe (connecté) - OTP sensible requis en plus du
// mot de passe actuel, défense en profondeur.
router.post('/change-password', requireAuth, validate(changePasswordSchema), requireSensitiveOtp, controller.changePassword);

// Récupération de compte (mot de passe oublié) - jamais connecté à ce stade.
router.post('/forgot-password', otpRequestLimiter, validate(forgotPasswordSchema), controller.forgotPassword);
router.post('/reset-password', loginLimiter, validate(resetPasswordSchema), controller.resetPassword);

// --- Gestion des sessions actives ---
router.get('/sessions', requireAuth, controller.listSessions);
router.delete('/sessions/:id', requireAuth, controller.revokeSession);

// Consultation / modification du profil (nom complet uniquement, téléphone immuable).
router.get('/profile', requireAuth, controller.getProfile);
router.put('/profile', requireAuth, validate(updateProfileSchema), controller.updateProfile);

// Code PIN de transaction - définition initiale et changement passent par
// la même route (toujours protégée par le mot de passe actuel, voir
// setTransactionPin). La vérification à l'usage se fait via le middleware
// requireTransactionPin, posé sur les routes sensibles (retrait, carte...).
router.get('/transaction-pin/status', requireAuth, controller.getTransactionPinStatus);
router.put('/transaction-pin', requireAuth, validate(setTransactionPinSchema), controller.setTransactionPin);

module.exports = router;

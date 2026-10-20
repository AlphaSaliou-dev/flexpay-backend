const authService = require('./auth.service');
const { logError } = require('../../utils/logger');

// Petit adaptateur pour éviter de répéter le try/catch AuthError dans
// chaque contrôleur.
function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof authService.AuthError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('auth', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const register = handle(async (req) => authService.register(req.body));

const resendOtp = handle(async (req) => authService.resendRegistrationOtp(req.body.phone));

const verifyOtp = handle(async (req) => authService.verifyPhoneOtp(req.body));

const login = handle(async (req) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || null;
  return authService.login(req.body, ip, userAgent);
});

const refresh = handle(async (req) => authService.refresh(req.body));

const requestSensitiveOtp = handle(async (req) => authService.requestSensitiveOtp(req.user.id));

const changePassword = handle(async (req) => authService.changePassword(req.user.id, req.body));
const forgotPassword = handle(async (req) => authService.requestPasswordReset(req.body.phone));
const resetPassword = handle(async (req) => authService.resetPassword(req.body));

const listSessions = handle(async (req) => authService.listActiveSessions(req.user.id, req.headers['x-refresh-token']));
const revokeSession = handle(async (req) => {
  await authService.revokeSession(req.user.id, req.params.id);
  return { revoked: true };
});

const getProfile = handle(async (req) => authService.getProfile(req.user.id));
const updateProfile = handle(async (req) => authService.updateProfile(req.user.id, req.body));

const getTransactionPinStatus = handle(async (req) => authService.getTransactionPinStatus(req.user.id));
const setTransactionPin = handle(async (req) => authService.setTransactionPin(req.user.id, req.body));

module.exports = {
  register, resendOtp, verifyOtp, login, refresh, requestSensitiveOtp, changePassword, forgotPassword, resetPassword,
  listSessions, revokeSession, getProfile, updateProfile, getTransactionPinStatus, setTransactionPin,
};

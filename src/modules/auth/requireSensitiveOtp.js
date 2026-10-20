const authService = require('./auth.service');
const { logError } = require('../../utils/logger');

// À poser devant toute route sensible future (ex: POST /wallet/withdraw,
// POST /wallet/sources). Suppose que requireAuth s'exécute avant (req.user
// doit déjà être défini). L'appelant doit fournir { otpCode } dans le body.
//
// Exemple d'usage futur :
//   router.post('/withdraw', requireAuth, requireSensitiveOtp, withdrawController)
async function requireSensitiveOtp(req, res, next) {
  const { otpCode } = req.body;

  if (!otpCode) {
    return res.status(400).json({ error: 'Code de confirmation requis pour cette action' });
  }

  try {
    await authService.consumeSensitiveOtp(req.user.id, otpCode);
    next();
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('requireSensitiveOtp', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { requireSensitiveOtp };

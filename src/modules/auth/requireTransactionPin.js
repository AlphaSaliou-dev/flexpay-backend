const authService = require('./auth.service');
const { logError } = require('../../utils/logger');

// Remplace requireSensitiveOtp sur les actions sensibles fréquentes
// (retrait, transfert, carte...) : un code PIN défini une fois par
// l'utilisateur, jamais un OTP envoyé par SMS à chaque action - voir
// auth.service.js (setTransactionPin/verifyTransactionPin). Suppose que
// requireAuth s'exécute avant. L'appelant doit fournir { pinCode } dans
// le body.
async function requireTransactionPin(req, res, next) {
  const { pinCode } = req.body;

  if (!pinCode) {
    return res.status(400).json({ error: 'Code PIN requis pour cette action' });
  }

  try {
    await authService.verifyTransactionPin(req.user.id, pinCode);
    next();
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('requireTransactionPin', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { requireTransactionPin };

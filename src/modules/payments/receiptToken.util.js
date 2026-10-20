const jwt = require('jsonwebtoken');

// Jamais le token d'accès général dans une URL (historique navigateur,
// logs de proxy, etc.) - ce token dédié ne peut servir qu'à télécharger
// UN reçu précis, et expire en 5 minutes. Même s'il fuit, son usage est
// négligeable comparé à un vrai token de session.
const RECEIPT_DOWNLOAD_AUDIENCE = 'flexpay-receipt-download';

function signReceiptDownloadToken(userId, transactionId) {
  return jwt.sign(
    { sub: userId, transactionId, aud: RECEIPT_DOWNLOAD_AUDIENCE },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '5m' }
  );
}

function verifyReceiptDownloadToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET, { audience: RECEIPT_DOWNLOAD_AUDIENCE });
}

module.exports = { signReceiptDownloadToken, verifyReceiptDownloadToken };

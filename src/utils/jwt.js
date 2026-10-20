const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Audience explicite sur le token d'accès normal - sans ça, n'importe
// quel autre JWT signé avec le même secret (ex: un token de téléchargement
// de reçu à portée volontairement restreinte) serait accepté ici comme
// une session complète, contournant entièrement la restriction voulue.
// Ce bug a été détecté par un test qui vérifiait précisément l'isolation
// entre ces deux types de tokens - jamais corrigé silencieusement après
// coup sans le signaler.
const ACCESS_TOKEN_AUDIENCE = 'flexpay-access';

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, phone: user.phone, type: 'access', aud: ACCESS_TOKEN_AUDIENCE },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET, { audience: ACCESS_TOKEN_AUDIENCE });
}

// Le refresh token brut n'est JAMAIS stocké en base : on stocke son hash SHA-256.
// Ça limite les dégâts si la base de données fuit un jour - un attaquant
// avec un dump de la DB ne peut pas rejouer les refresh tokens.
function generateRefreshToken() {
  const raw = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};

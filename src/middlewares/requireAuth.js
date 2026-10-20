const { verifyAccessToken } = require('../utils/jwt');
const prisma = require('../config/db');

// Vérifie le token JWT et attache l'utilisateur à req.user.
// Recharge toujours le statut depuis la base (pas seulement le payload du
// token) : un compte suspendu APRÈS l'émission du token doit être bloqué
// immédiatement, pas seulement à l'expiration du token (15 min plus tard).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  const token = header.slice('Bearer '.length);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });

  if (!user || user.status === 'SUSPENDED' || user.status === 'LOCKED') {
    return res.status(403).json({ error: 'Compte indisponible' });
  }

  req.user = { id: user.id, phone: user.phone, status: user.status };
  next();
}

module.exports = { requireAuth };

const { verifyAdminToken } = require('./adminAuth.service');
const prisma = require('../../config/db');

async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification admin requise' });
  }

  let payload;
  try {
    payload = verifyAdminToken(header.slice('Bearer '.length));
  } catch (err) {
    return res.status(401).json({ error: 'Token admin invalide ou expiré' });
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
  if (!admin || admin.status !== 'ACTIVE') {
    return res.status(403).json({ error: 'Compte admin indisponible' });
  }

  req.admin = { id: admin.id, email: admin.email, role: admin.role };
  next();
}

// Ex: requireRole('SUPERADMIN') ou requireRole('COMPLIANCE', 'SUPERADMIN')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Authentification admin requise' });
    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({ error: "Rôle insuffisant pour cette action" });
    }
    next();
  };
}

module.exports = { requireAdminAuth, requireRole };

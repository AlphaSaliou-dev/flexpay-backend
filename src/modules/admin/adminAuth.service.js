const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');
const QRCode = require('qrcode');
const prisma = require('../../config/db');

class AdminAuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Deux audiences JWT distinctes, jamais interchangeables : un token
// "2FA en attente" ne doit JAMAIS pouvoir passer requireAdminAuth, même
// par erreur - l'audience différente le garantit au niveau de la
// vérification elle-même, pas juste par convention de code.
const FULL_SESSION_AUDIENCE = 'flexpay-admin';
const PENDING_2FA_AUDIENCE = 'flexpay-admin-2fa-pending';

// Tolérance de ±30s (1 pas de temps avant/après) : les horloges des
// téléphones dérivent légèrement, un TOTP au format RFC strict (tolérance
// 0) rejette trop souvent des codes pourtant valides.
const TOTP_EPOCH_TOLERANCE = 30;

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, role: admin.role, aud: FULL_SESSION_AUDIENCE },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: process.env.JWT_ADMIN_EXPIRES_IN || '8h' }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, process.env.JWT_ADMIN_SECRET, { audience: FULL_SESSION_AUDIENCE });
}

function signPendingTotpToken(admin) {
  // Durée de vie volontairement très courte (2 min) : ce token ne sert
  // qu'à relier l'étape 1 (mot de passe) à l'étape 2 (code TOTP) du même
  // login, jamais à autoriser quoi que ce soit par lui-même.
  return jwt.sign({ sub: admin.id, aud: PENDING_2FA_AUDIENCE }, process.env.JWT_ADMIN_SECRET, {
    expiresIn: '2m',
  });
}

function verifyPendingTotpToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_ADMIN_SECRET, { audience: PENDING_2FA_AUDIENCE });
  } catch (err) {
    throw new AdminAuthError('Session de connexion expirée, recommencez depuis le mot de passe', 401);
  }
}

async function verifyTotpCode(token, secret) {
  const result = await otplib.verify({ token, secret, epochTolerance: TOTP_EPOCH_TOLERANCE });
  return result.valid;
}

// --- Étape 1 : email + mot de passe ------------------------------------------

async function login({ email, password }) {
  const admin = await prisma.adminUser.findUnique({ where: { email } });

  const genericError = () => new AdminAuthError('Identifiants invalides', 401);
  if (!admin || admin.status !== 'ACTIVE') throw genericError();

  const valid = await argon2.verify(admin.passwordHash, password);
  if (!valid) throw genericError();

  // Aucun compte admin ne peut fonctionner sans 2FA - jamais optionnel.
  // Si ce n'est pas encore configuré, on génère un secret et on force la
  // configuration avant de délivrer quoi que ce soit d'utilisable.
  if (!admin.totpEnabled) {
    const secret = await otplib.generateSecret();
    await prisma.adminUser.update({ where: { id: admin.id }, data: { totpSecret: secret } });

    const otpauthUrl = await otplib.generateURI({ issuer: 'FlexPay Admin', label: admin.email, secret });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return {
      setupRequired: true,
      pendingToken: signPendingTotpToken(admin),
      secret, // affiché en solution de secours si le QR ne scanne pas
      qrCodeDataUrl,
    };
  }

  return { totpRequired: true, pendingToken: signPendingTotpToken(admin) };
}

// --- Étape 2a : première configuration du 2FA (confirmation du 1er code) ---

async function confirmTotpSetup(pendingToken, code) {
  const payload = verifyPendingTotpToken(pendingToken);
  const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });

  if (!admin || !admin.totpSecret) {
    throw new AdminAuthError('Configuration 2FA introuvable, recommencez depuis le mot de passe', 401);
  }

  const valid = await verifyTotpCode(code, admin.totpSecret);
  if (!valid) throw new AdminAuthError('Code de vérification invalide', 401);

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { totpEnabled: true, lastLoginAt: new Date() },
  });

  return { token: signAdminToken(admin), admin: { id: admin.id, email: admin.email, role: admin.role } };
}

// --- Étape 2b : vérification du code à chaque connexion suivante -----------

async function verifyTotp(pendingToken, code) {
  const payload = verifyPendingTotpToken(pendingToken);
  const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });

  if (!admin || !admin.totpEnabled || !admin.totpSecret) {
    throw new AdminAuthError('2FA non configurée pour ce compte, recommencez depuis le mot de passe', 401);
  }

  const valid = await verifyTotpCode(code, admin.totpSecret);
  if (!valid) throw new AdminAuthError('Code de vérification invalide', 401);

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  return { token: signAdminToken(admin), admin: { id: admin.id, email: admin.email, role: admin.role } };
}

module.exports = {
  AdminAuthError,
  signAdminToken,
  verifyAdminToken,
  login,
  confirmTotpSetup,
  verifyTotp,
};

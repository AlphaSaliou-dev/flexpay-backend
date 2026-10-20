const argon2 = require('argon2');
const prisma = require('../../config/db');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} = require('../../utils/jwt');
const {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiryDate,
  sendOtpBySms,
} = require('../../utils/otp');
const { notifyUser } = require('../notifications/notification.service');

const MAX_FAILED_ATTEMPTS = Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS || 5);
const LOCK_MINUTES = Number(process.env.ACCOUNT_LOCK_MINUTES || 15);
const MAX_PIN_ATTEMPTS = Number(process.env.MAX_PIN_ATTEMPTS || 5);
const PIN_LOCK_MINUTES = Number(process.env.PIN_LOCK_MINUTES || 15);
const REFRESH_EXPIRES_DAYS = 30;

class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function audit(userId, action, metadata = {}, ipAddress = null) {
  // Écriture seule - jamais de update/delete sur AuditLog ailleurs dans le code.
  await prisma.auditLog.create({
    data: { userId, action, metadata, ipAddress },
  });
}

// --- Inscription -----------------------------------------------------------

async function register({ phone, password, fullName, declaresCommercialUse, acceptedTerms }) {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    // Message volontairement générique : on ne confirme jamais qu'un numéro
    // est déjà enregistré, ça éviterait à un attaquant de vérifier quels
    // numéros existent sur la plateforme (énumération de comptes).
    throw new AuthError("Impossible de créer le compte avec ces informations", 400);
  }

  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash,
      fullName,
      declaresCommercialUse: Boolean(declaresCommercialUse),
      // acceptedTerms est garanti === true par registerSchema (z.literal) -
      // aucun compte n'est créé sans acceptation explicite des CGU/politique.
      termsAcceptedAt: acceptedTerms ? new Date() : null,
    },
  });

  await sendVerificationOtp(user);
  await audit(user.id, 'REGISTER', { declaresCommercialUse: Boolean(declaresCommercialUse) });

  return { userId: user.id, phone: user.phone };
}

async function sendVerificationOtp(user) {
  const code = generateOtpCode();
  const codeHash = await hashOtpCode(code);

  await prisma.otpCode.create({
    data: {
      userId: user.id,
      codeHash,
      purpose: 'PHONE_VERIFICATION',
      expiresAt: otpExpiryDate(),
    },
  });

  await sendOtpBySms(user.phone, code);
}

// Renvoie un nouveau code de vérification à un compte qui vient de
// s'inscrire mais n'a pas encore confirmé son numéro (register() refuse
// tout second appel sur le même numéro, donc register ne peut jamais
// servir de "renvoyer le code"). Message générique dans tous les cas
// d'échec - jamais de distinction "compte inexistant" / "déjà vérifié",
// même logique d'anti-énumération que register().
async function resendRegistrationOtp(phone) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || user.status !== 'PENDING_VERIFICATION') {
    throw new AuthError("Impossible d'envoyer un nouveau code pour ce numéro", 400);
  }

  await sendVerificationOtp(user);
  return { sent: true };
}

// --- Vérification du numéro de téléphone -----------------------------------

async function verifyPhoneOtp({ phone, code }) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) throw new AuthError('Code invalide', 400);

  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      purpose: 'PHONE_VERIFICATION',
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new AuthError('Code expiré ou introuvable, demandez-en un nouveau', 400);

  if (otp.attempts >= Number(process.env.OTP_MAX_ATTEMPTS || 3)) {
    throw new AuthError('Trop de tentatives, demandez un nouveau code', 429);
  }

  const isValid = await verifyOtpCode(code, otp.codeHash);

  if (!isValid) {
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AuthError('Code invalide', 400);
  }

  await prisma.$transaction([
    prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } }),
  ]);

  await audit(user.id, 'PHONE_VERIFIED');

  return { verified: true };
}

// --- Connexion ---------------------------------------------------------------

async function login({ phone, password }, ipAddress, userAgent) {
  const user = await prisma.user.findUnique({ where: { phone } });

  // Même message d'erreur que le compte existe ou non, et que le mot de
  // passe soit faux ou non - toujours "Identifiants invalides". Distinguer
  // les deux cas dans la réponse aiderait un attaquant à deviner quels
  // numéros sont inscrits (énumération de comptes).
  const genericError = () => new AuthError('Identifiants invalides', 401);

  if (!user) throw genericError();

  if (user.status === 'SUSPENDED') {
    throw new AuthError('Compte suspendu, contactez le support', 403);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.lockedUntil - new Date()) / 60000);
    throw new AuthError(`Compte temporairement verrouillé. Réessayez dans ${minutesLeft} min.`, 403);
  }

  const passwordValid = await argon2.verify(user.passwordHash, password);

  if (!passwordValid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : user.lockedUntil,
      },
    });

    await audit(user.id, 'LOGIN_FAILED', { attempts }, ipAddress);

    if (shouldLock) {
      await notifyUser(
        user.id,
        {
          type: 'ACCOUNT_LOCKED',
          title: 'Compte verrouillé',
          body: `Trop de tentatives de connexion échouées. Réessayez dans ${LOCK_MINUTES} minutes.`,
        },
        `FlexPay : votre compte a été temporairement verrouillé après plusieurs tentatives de connexion échouées. Si ce n'était pas vous, contactez le support.`
      );
    }

    throw genericError();
  }

  if (user.status === 'PENDING_VERIFICATION') {
    throw new AuthError('Numéro de téléphone non vérifié', 403);
  }

  // Connexion réussie : on repart à zéro sur les tentatives échouées.
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });

  const accessToken = signAccessToken(user);
  const { raw: refreshTokenRaw, hash: refreshTokenHash } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refreshTokenHash,
      expiresAt: new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
      ipAddress,
      userAgent,
    },
  });

  await audit(user.id, 'LOGIN_SUCCESS', {}, ipAddress);

  // Alerte à chaque connexion réussie (pas seulement "nouvel appareil" -
  // aucun fingerprinting d'appareil n'existe dans ce système) : si ce
  // n'est pas l'utilisateur qui vient de se connecter, c'est le signal
  // le plus tôt possible pour réagir.
  await notifyUser(
    user.id,
    { type: 'NEW_LOGIN', title: 'Nouvelle connexion', body: 'Une connexion à votre compte vient d\'avoir lieu.', data: { ipAddress } },
    "FlexPay : une connexion à votre compte vient d'avoir lieu. Si ce n'était pas vous, changez votre mot de passe immédiatement."
  );

  return { accessToken, refreshToken: refreshTokenRaw, user: { id: user.id, phone: user.phone } };
}

// --- Rafraîchissement du token ------------------------------------------------

async function refresh({ refreshToken }) {
  const tokenHash = hashRefreshToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AuthError('Session expirée, reconnectez-vous', 401);
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || user.status !== 'ACTIVE') {
    throw new AuthError('Compte indisponible', 403);
  }

  // Rotation du refresh token : l'ancien est révoqué, un nouveau est émis.
  // Ça limite l'usage d'un refresh token volé (usage unique).
  const { raw: newRaw, hash: newHash } = generateRefreshToken();

  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: newHash,
        expiresAt: new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
      },
    }),
  ]);

  const accessToken = signAccessToken(user);

  return { accessToken, refreshToken: newRaw };
}

// --- OTP pour actions sensibles (retrait, ajout de source de paiement...) ---
// Flux en 2 temps : l'utilisateur (déjà connecté) demande un code, puis le
// fournit à nouveau au moment d'exécuter l'action sensible elle-même.
// La vérification se fait via le middleware requireSensitiveOtp, réutilisable
// sur n'importe quelle route sensible future (wallet, virements...).

async function requestSensitiveOtp(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);

  const code = generateOtpCode();
  const codeHash = await hashOtpCode(code);

  await prisma.otpCode.create({
    data: {
      userId: user.id,
      codeHash,
      purpose: 'SENSITIVE_ACTION',
      expiresAt: otpExpiryDate(),
    },
  });

  await sendOtpBySms(user.phone, code);
  await audit(user.id, 'SENSITIVE_OTP_REQUESTED');

  return { sent: true };
}

async function consumeSensitiveOtp(userId, code) {
  const otp = await prisma.otpCode.findFirst({
    where: {
      userId,
      purpose: 'SENSITIVE_ACTION',
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new AuthError('Code expiré ou introuvable, redemandez-en un', 400);

  if (otp.attempts >= Number(process.env.OTP_MAX_ATTEMPTS || 3)) {
    throw new AuthError('Trop de tentatives, redemandez un code', 429);
  }

  const isValid = await verifyOtpCode(code, otp.codeHash);

  if (!isValid) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new AuthError('Code invalide', 400);
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  await audit(userId, 'SENSITIVE_OTP_VERIFIED');
}

// Révoque tous les refresh tokens actifs d'un utilisateur - appelé après
// tout changement de mot de passe (volontaire ou via récupération). Sans
// ça, une session déjà volée avant le changement resterait valide
// indéfiniment malgré le nouveau mot de passe.
async function revokeAllRefreshTokens(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// --- Gestion des sessions actives (un appareil = un refresh token) ---------
// Permet à un utilisateur de voir tous ses appareils connectés et d'en
// déconnecter un précisément (ex: téléphone volé) sans devoir tout
// déconnecter comme le fait revokeAllRefreshTokens.

// currentRawRefreshToken (optionnel) permet à l'appelant de savoir laquelle
// de ses sessions est celle en cours - sans ça, aucune des lignes renvoyées
// ne peut se distinguer côté interface, alors que c'est précisément
// l'appareil qu'on ne doit jamais proposer de déconnecter par erreur.
// Résolu par une requête ciblée séparée (id seul) plutôt qu'en sélectionnant
// tokenHash dans le listing général : le hash ne doit jamais transiter par
// la liste complète, même en interne, uniquement par cette comparaison
// ponctuelle et déjà hashée.
async function listActiveSessions(userId, currentRawRefreshToken) {
  const [tokens, currentSession] = await Promise.all([
    prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true },
    }),
    currentRawRefreshToken
      ? prisma.refreshToken.findUnique({
          where: { tokenHash: hashRefreshToken(currentRawRefreshToken) },
          select: { id: true },
        })
      : null,
  ]);

  return tokens.map((session) => ({
    ...session,
    isCurrent: currentSession != null && session.id === currentSession.id,
  }));
}

async function revokeSession(userId, sessionId) {
  const token = await prisma.refreshToken.findUnique({ where: { id: sessionId } });

  // Même erreur qu'une session inexistante si elle appartient à un autre
  // utilisateur - ne jamais révéler qu'une session d'un tiers existe.
  if (!token || token.userId !== userId) {
    throw new AuthError('Session introuvable', 404);
  }
  if (token.revokedAt) {
    throw new AuthError('Cette session est déjà déconnectée', 409);
  }

  await prisma.refreshToken.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  await audit(userId, 'SESSION_REVOKED', { sessionId });
}

// --- Changement de mot de passe (utilisateur déjà connecté) ----------------

async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);

  const valid = await argon2.verify(user.passwordHash, currentPassword);
  if (!valid) throw new AuthError('Mot de passe actuel incorrect', 401);

  const newPasswordHash = await argon2.hash(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: newPasswordHash } });
  await revokeAllRefreshTokens(userId);
  await audit(userId, 'PASSWORD_CHANGED');

  await notifyUser(
    userId,
    {
      type: 'PASSWORD_CHANGED',
      title: 'Mot de passe modifié',
      body: 'Votre mot de passe a été changé. Toutes vos autres sessions ont été déconnectées.',
    },
    "FlexPay : votre mot de passe vient d'être modifié. Si ce n'était pas vous, contactez le support immédiatement."
  );

  return { changed: true };
}

// --- Code PIN de transaction (retrait, transfert, carte...) ----------------
// Remplace l'OTP par SMS pour les actions sensibles fréquentes - voir
// requireTransactionPin.js. Un seul PIN par compte, jamais envoyé par SMS
// (transite en HTTPS comme le mot de passe), avec le même verrouillage
// progressif que la connexion (failedLoginAttempts/lockedUntil).

async function getTransactionPinStatus(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);
  return { isSet: Boolean(user.transactionPinHash) };
}

// Toujours protégé par le mot de passe actuel, jamais par le PIN lui-même
// (sinon un PIN compromis permettrait d'en redéfinir un autre en boucle) -
// même logique de défense en profondeur que changePassword.
async function setTransactionPin(userId, { currentPin, pin }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);

  const isChange = Boolean(user.transactionPinHash);

  if (isChange) {
    if (!currentPin) throw new AuthError('Code PIN actuel requis', 400);
    // Réutilise verifyTransactionPin (pas un argon2.verify direct) pour
    // garder le même verrouillage progressif ici que sur une vraie
    // transaction - sinon cette route deviendrait un moyen de deviner le
    // PIN actuel sans jamais se faire bloquer.
    await verifyTransactionPin(userId, currentPin);
  }

  const pinHash = await argon2.hash(pin);

  await prisma.user.update({
    where: { id: userId },
    data: { transactionPinHash: pinHash, transactionPinFailedAttempts: 0, transactionPinLockedUntil: null },
  });

  await audit(userId, isChange ? 'TRANSACTION_PIN_CHANGED' : 'TRANSACTION_PIN_SET');

  if (isChange) {
    await notifyUser(
      userId,
      {
        type: 'TRANSACTION_PIN_CHANGED',
        title: 'Code PIN modifié',
        body: 'Votre code PIN de transaction a été modifié.',
      },
      "FlexPay : votre code PIN de transaction vient d'être modifié. Si ce n'était pas vous, contactez le support immédiatement."
    );
  }

  return { set: true };
}

async function verifyTransactionPin(userId, pin) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);

  if (!user.transactionPinHash) {
    throw new AuthError('Code PIN non défini, définissez-le dans les paramètres', 403);
  }

  if (user.transactionPinLockedUntil && user.transactionPinLockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.transactionPinLockedUntil - new Date()) / 60000);
    throw new AuthError(`Code PIN temporairement verrouillé. Réessayez dans ${minutesLeft} min.`, 403);
  }

  const valid = await argon2.verify(user.transactionPinHash, pin);

  if (!valid) {
    const attempts = user.transactionPinFailedAttempts + 1;
    const shouldLock = attempts >= MAX_PIN_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        transactionPinFailedAttempts: shouldLock ? 0 : attempts,
        transactionPinLockedUntil: shouldLock
          ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000)
          : user.transactionPinLockedUntil,
      },
    });

    if (shouldLock) {
      await notifyUser(
        userId,
        {
          type: 'TRANSACTION_PIN_LOCKED',
          title: 'Code PIN verrouillé',
          body: `Trop de tentatives de code PIN échouées. Réessayez dans ${PIN_LOCK_MINUTES} minutes.`,
        },
        `FlexPay : votre code PIN a été verrouillé après plusieurs tentatives échouées. Réessayez dans ${PIN_LOCK_MINUTES} minutes.`
      );
    }

    throw new AuthError('Code PIN invalide', 400);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { transactionPinFailedAttempts: 0, transactionPinLockedUntil: null },
  });
}

// --- Récupération de compte (mot de passe oublié, par téléphone + OTP) -----

async function requestPasswordReset(phone) {
  const user = await prisma.user.findUnique({ where: { phone } });

  // Toujours la même réponse, que le numéro existe ou non - sinon on
  // permettrait à quiconque de vérifier quels numéros sont inscrits sur
  // FlexPay simplement en tapant des numéros au hasard sur cet écran.
  if (!user || user.status !== 'ACTIVE') {
    return { sent: true };
  }

  const code = generateOtpCode();
  const codeHash = await hashOtpCode(code);

  await prisma.otpCode.create({
    data: { userId: user.id, codeHash, purpose: 'PASSWORD_RESET', expiresAt: otpExpiryDate() },
  });

  await sendOtpBySms(user.phone, code);
  await audit(user.id, 'PASSWORD_RESET_REQUESTED');

  return { sent: true };
}

async function resetPassword({ phone, code, newPassword }) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) throw new AuthError('Code invalide', 400); // même erreur générique qu'un mauvais code

  const otp = await prisma.otpCode.findFirst({
    where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new AuthError('Code expiré ou introuvable, redemandez-en un', 400);

  if (otp.attempts >= Number(process.env.OTP_MAX_ATTEMPTS || 3)) {
    throw new AuthError('Trop de tentatives, redemandez un code', 429);
  }

  const isValid = await verifyOtpCode(code, otp.codeHash);
  if (!isValid) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new AuthError('Code invalide', 400);
  }

  const newPasswordHash = await argon2.hash(newPassword);

  await prisma.$transaction([
    prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
    // Une récupération de compte réussie lève aussi un éventuel
    // verrouillage pour tentatives échouées - la personne vient de
    // prouver son identité via un canal plus fort (SMS) que le mot de
    // passe qu'elle a oublié.
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash, failedLoginAttempts: 0, lockedUntil: null },
    }),
  ]);

  await revokeAllRefreshTokens(user.id);
  await audit(user.id, 'PASSWORD_RESET_COMPLETED');

  return { reset: true };
}

// --- Consultation / modification du profil (nom complet uniquement) --------
// Le téléphone est l'identifiant du compte, jamais modifiable ici - le
// changer reviendrait à changer d'identité, ce qui doit passer par un
// tout autre parcours (hors scope actuel).

async function getProfile(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError('Utilisateur introuvable', 404);
  return { id: user.id, phone: user.phone, fullName: user.fullName };
}

async function updateProfile(userId, { fullName }) {
  const user = await prisma.user.update({ where: { id: userId }, data: { fullName } });
  await audit(userId, 'PROFILE_UPDATED', { fullName });
  return { id: user.id, phone: user.phone, fullName: user.fullName };
}

module.exports = {
  AuthError,
  register,
  resendRegistrationOtp,
  verifyPhoneOtp,
  login,
  refresh,
  audit,
  requestSensitiveOtp,
  consumeSensitiveOtp,
  sendVerificationOtp,
  changePassword,
  requestPasswordReset,
  resetPassword,
  getProfile,
  updateProfile,
  listActiveSessions,
  revokeSession,
  getTransactionPinStatus,
  setTransactionPin,
  verifyTransactionPin,
};

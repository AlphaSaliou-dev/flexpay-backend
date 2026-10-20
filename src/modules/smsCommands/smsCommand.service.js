const crypto = require('crypto');
const prisma = require('../../config/db');
const {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiryDate,
  sendSmsText,
} = require('../../utils/otp');
const walletService = require('../wallet/wallet.service');
const { LimitExceededError } = require('../wallet/limits.guard');
const { logError } = require('../../utils/logger');

const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 3);
const REFERENCE_LENGTH = 6;
const EXTERNAL_PROVIDERS = ['orange_money', 'mtn_momo'];

class SmsCommandError extends Error {}

// --- Référence opaque (destinataire caché, même à son propre titulaire) ---
// Numérique plutôt qu'alphanumérique : plus simple à saisir sur un clavier
// de téléphone classique (pas de bascule majuscule/lettres). 6 chiffres ne
// se confond jamais avec un numéro réel (toujours préfixé +224 et bien
// plus long) - voir resolveDestination.

async function getOrCreateSmsReference(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  if (user.smsReference) return user.smsReference;

  // Collision improbable (1 million de combinaisons) mais vérifiée quand
  // même avant d'écrire - jamais écraser la référence de quelqu'un d'autre.
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = crypto
      .randomInt(0, 10 ** REFERENCE_LENGTH)
      .toString()
      .padStart(REFERENCE_LENGTH, '0');
    const existing = await prisma.user.findUnique({ where: { smsReference: candidate } });
    if (!existing) {
      const updated = await prisma.user.update({ where: { id: userId }, data: { smsReference: candidate } });
      return updated.smsReference;
    }
  }
  throw new Error('Impossible de générer une référence SMS unique après 10 tentatives');
}

// --- OTP par commande : authentifie CHAQUE commande (pas de session SMS) --
// Règle non négociable du mode hors ligne : seul un code à usage unique
// voyage par SMS, jamais le code PIN (qui lui ne doit JAMAIS transiter
// par un canal interceptable) - voir FlexPay_Mode_Hors_Ligne_SMS.md.

async function requestCommandOtp(user) {
  const code = generateOtpCode();
  const codeHash = await hashOtpCode(code);
  await prisma.otpCode.create({
    data: { userId: user.id, codeHash, purpose: 'SMS_COMMAND', expiresAt: otpExpiryDate() },
  });
  await sendSmsText(
    user.phone,
    `FlexPay : votre code est ${code} (valable 5 min). Renvoyez votre commande en l'ajoutant à la fin.`
  );
}

async function consumeCommandOtp(userId, code) {
  if (!code) throw new SmsCommandError('Code manquant à la fin de la commande.');

  const otp = await prisma.otpCode.findFirst({
    where: { userId, purpose: 'SMS_COMMAND', consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new SmsCommandError('Code expiré ou introuvable. Envoyez OTP pour en recevoir un nouveau.');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw new SmsCommandError('Trop de tentatives pour ce code. Envoyez OTP pour en recevoir un nouveau.');
  }

  const isValid = await verifyOtpCode(code, otp.codeHash);
  if (!isValid) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new SmsCommandError('Code invalide.');
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
}

// --- Résolution d'un destinataire : référence opaque, ou repli en clair ---
// pour un tout premier contact jamais mis en cache hors ligne par l'app
// (décision actée : accepter cette limite plutôt que bloquer l'envoi).

async function resolveDestination(token) {
  if (/^\d{6}$/.test(token)) {
    const user = await prisma.user.findUnique({ where: { smsReference: token } });
    if (!user) throw new SmsCommandError('Référence destinataire inconnue.');
    return user.phone;
  }
  if (/^\+?224\d{8,9}$/.test(token)) {
    return token.startsWith('+') ? token : `+${token}`;
  }
  throw new SmsCommandError('Destinataire invalide (numéro ou référence à 6 chiffres attendu).');
}

function parseAmount(raw) {
  const amount = Number(raw);
  if (!raw || Number.isNaN(amount) || amount <= 0) throw new SmsCommandError('Montant invalide.');
  return amount;
}

function parseExternalProvider(raw) {
  const provider = String(raw || '').toLowerCase();
  if (!EXTERNAL_PROVIDERS.includes(provider)) {
    throw new SmsCommandError(`Moyen invalide. Utilisez : ${EXTERNAL_PROVIDERS.join(' ou ')}.`);
  }
  return provider;
}

// Idempotence : dérivée de l'identifiant du message donné par le
// fournisseur SMS quand il existe, pour qu'un webhook rejoué (retry réseau
// côté fournisseur) ne déclenche jamais un second mouvement d'argent. Sans
// cet identifiant (fournisseur inconnu), repli sur un UUID par appel -
// limite acceptée en l'absence d'un vrai identifiant de message fiable.
function idempotencyKeyFor(messageId, suffix) {
  return messageId ? `sms:${messageId}:${suffix}` : crypto.randomUUID();
}

async function handleCommand(user, command, args, messageId) {
  switch (command) {
    case 'OTP':
      await requestCommandOtp(user);
      return;

    case 'SOLDE': {
      await consumeCommandOtp(user.id, args[0]);
      const { balance } = await walletService.getBalance(user.id);
      await sendSmsText(user.phone, `FlexPay : votre solde est de ${balance.toLocaleString('fr-FR')} GNF.`);
      return;
    }

    case 'DEPOT': {
      const [amountRaw, providerRaw, otpCode] = args;
      await consumeCommandOtp(user.id, otpCode);
      const amount = parseAmount(amountRaw);
      const provider = parseExternalProvider(providerRaw);
      await walletService.deposit(user.id, {
        amount,
        idempotencyKey: idempotencyKeyFor(messageId, 'deposit'),
        provider,
      });
      await sendSmsText(user.phone, `FlexPay : dépôt de ${amount.toLocaleString('fr-FR')} GNF confirmé.`);
      return;
    }

    case 'RETRAIT': {
      const [amountRaw, providerRaw, otpCode] = args;
      await consumeCommandOtp(user.id, otpCode);
      const amount = parseAmount(amountRaw);
      const provider = parseExternalProvider(providerRaw);
      await walletService.withdraw(user.id, {
        amount,
        idempotencyKey: idempotencyKeyFor(messageId, 'withdraw'),
        provider,
      });
      await sendSmsText(user.phone, `FlexPay : retrait de ${amount.toLocaleString('fr-FR')} GNF confirmé.`);
      return;
    }

    case 'ENVOI': {
      const [amountRaw, destToken, otpCode] = args;
      await consumeCommandOtp(user.id, otpCode);
      const amount = parseAmount(amountRaw);
      if (!destToken) throw new SmsCommandError('Destinataire manquant. Format : ENVOI <montant> <référence ou numéro> <code>');
      const toPhone = await resolveDestination(destToken);
      await walletService.transfer(user.id, {
        toPhone,
        amount,
        idempotencyKey: idempotencyKeyFor(messageId, 'transfer'),
      });
      await sendSmsText(user.phone, `FlexPay : envoi de ${amount.toLocaleString('fr-FR')} GNF confirmé.`);
      return;
    }

    default:
      await sendSmsText(
        user.phone,
        'FlexPay : commande inconnue. Envoyez OTP, SOLDE, DEPOT, RETRAIT ou ENVOI (suivi du code reçu).'
      );
  }
}

// --- Point d'entrée unique : un SMS entrant --------------------------------

async function handleIncomingSms({ from, text, messageId }) {
  const user = await prisma.user.findUnique({ where: { phone: from } });
  if (!user) {
    await sendSmsText(from, "FlexPay : ce numéro n'est associé à aucun compte FlexPay.");
    return;
  }

  const parts = String(text || '').trim().split(/\s+/);
  const command = (parts[0] || '').toUpperCase();
  const args = parts.slice(1);

  try {
    await handleCommand(user, command, args, messageId);
  } catch (err) {
    if (err instanceof SmsCommandError || err instanceof walletService.WalletError || err instanceof LimitExceededError) {
      await sendSmsText(from, `FlexPay : ${err.message}`);
      return;
    }
    logError('smsCommand', err);
    await sendSmsText(from, 'FlexPay : une erreur est survenue, réessayez.');
  }
}

module.exports = {
  SmsCommandError,
  getOrCreateSmsReference,
  handleIncomingSms,
};

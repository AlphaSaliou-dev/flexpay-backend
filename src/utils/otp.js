const crypto = require('crypto');
const argon2 = require('argon2');

const OTP_LENGTH = Number(process.env.OTP_LENGTH || 6);
const OTP_EXPIRES_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES || 5);

function generateOtpCode() {
  // Code numérique, ex: "483920" - jamais de code prévisible (pas de Date.now())
  const max = 10 ** OTP_LENGTH;
  const code = crypto.randomInt(0, max).toString().padStart(OTP_LENGTH, '0');
  return code;
}

async function hashOtpCode(code) {
  return argon2.hash(code);
}

async function verifyOtpCode(code, hash) {
  return argon2.verify(hash, code);
}

function otpExpiryDate() {
  return new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);
}

// Fournisseur SMS : Nimba SMS pour la Guinée (déjà utilisé sur MarketConnect,
// donc intégration réutilisable). À bascule vers Twilio lors de l'expansion
// régionale hors Guinée, via SMS_PROVIDER pour ne pas dupliquer ce fichier.
// Ceci n'envoie rien pour l'instant - brancher le vrai appel API avant déploiement.
async function sendOtpBySms(phone, code) {
  const provider = process.env.SMS_PROVIDER || 'nimba_sms';

  if (provider === 'nimba_sms') {
    console.log(`[DEV ONLY - Nimba SMS] OTP pour ${phone} : ${code}`);
    // await nimbaSmsClient.send({ to: phone, message: `Votre code FlexPay : ${code}` });
  } else if (provider === 'twilio') {
    console.log(`[DEV ONLY - Twilio] OTP pour ${phone} : ${code}`);
    // await twilioClient.messages.create({ to: phone, body: `Votre code FlexPay : ${code}` });
  } else {
    throw new Error(`Fournisseur SMS inconnu : ${provider}`);
  }
}

// Envoi d'un texte libre par SMS (confirmation/erreur de commande hors
// ligne, pas un code) - même bascule de fournisseur que sendOtpBySms,
// factorisée séparément pour ne pas donner un nom trompeur ("Otp") à un
// message qui n'en est pas un.
async function sendSmsText(phone, message) {
  const provider = process.env.SMS_PROVIDER || 'nimba_sms';

  if (provider === 'nimba_sms') {
    console.log(`[DEV ONLY - Nimba SMS] SMS pour ${phone} : ${message}`);
    // await nimbaSmsClient.send({ to: phone, message });
  } else if (provider === 'twilio') {
    console.log(`[DEV ONLY - Twilio] SMS pour ${phone} : ${message}`);
    // await twilioClient.messages.create({ to: phone, body: message });
  } else {
    throw new Error(`Fournisseur SMS inconnu : ${provider}`);
  }
}

module.exports = {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiryDate,
  sendOtpBySms,
  sendSmsText,
};

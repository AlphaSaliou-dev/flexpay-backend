const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // taille recommandée pour GCM (96 bits)
const AUTH_TAG_LENGTH = 16; // taille fixe du tag GCM par défaut

// Chiffrement symétrique RÉVERSIBLE (AES-256-GCM), pour tout secret qui
// doit pouvoir être RELU en clair plus tard - ex: le secret webhook,
// réutilisé pour signer chaque envoi. Jamais pour un mot de passe/PIN/OTP :
// ceux-là doivent rester hachés (argon2), à sens unique - voir
// auth.service.js. Confondre les deux serait aussi grave dans un sens que
// dans l'autre (un mot de passe chiffré au lieu de haché redeviendrait
// lisible si la clé fuit ; un secret webhook haché ne pourrait plus
// jamais être relu pour signer).
function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error('ENCRYPTION_KEY manquant dans l\'environnement');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY doit représenter 32 octets (64 caractères hexadécimaux)');
  }
  return key;
}

// Format auto-descriptif (iv:authTag:ciphertext, chacun en base64) - pas
// besoin de colonnes séparées pour l'IV/le tag, toute la valeur chiffrée
// tient dans une seule chaîne stockable là où vivait la valeur en clair.
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// GCM est une encryption AUTHENTIFIÉE : toute altération du texte chiffré
// (ou du tag) fait échouer decrypt() au lieu de renvoyer silencieusement
// une valeur corrompue - utile si jamais quelqu'un modifiait directement
// une ligne en base.
function decrypt(encoded) {
  const key = getKey();
  const parts = String(encoded).split(':');
  if (parts.length !== 3) throw new Error('Valeur chiffrée malformée');
  const [ivB64, authTagB64, ciphertextB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Variante binaire (fichiers KYC/KYB : pièces d'identité, selfies,
// documents d'entreprise) - même algorithme, mais iv+authTag+ciphertext
// concaténés en un seul Buffer plutôt qu'encodés en base64 dans une
// chaîne : pas de perte de place (~33%) inutile pour un fichier qui sera
// de toute façon écrit tel quel sur le disque, jamais affiché dans une
// colonne texte.
function encryptBuffer(buffer) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decryptBuffer(encryptedBuffer) {
  const key = getKey();
  if (encryptedBuffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Fichier chiffré malformé (trop court)');
  }
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encrypt, decrypt, encryptBuffer, decryptBuffer };

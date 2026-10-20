// Fournisseur de développement - ne parle à aucune vraie API. Permet de
// construire et tester tout le module carte virtuelle avant même d'avoir
// choisi et signé avec un émetteur réel. À remplacer dans
// virtualCard.service.js une fois le partenaire choisi (voir
// cardProvider.interface.js pour le contrat à respecter).

const crypto = require('crypto');

async function createCard(user) {
  const providerCardId = `mock_${crypto.randomBytes(8).toString('hex')}`;
  const last4 = crypto.randomInt(1000, 9999);
  return {
    providerCardId,
    maskedNumber: `**** **** **** ${last4}`,
    currency: 'USD',
  };
}

async function topUp(providerCardId, amount) {
  console.log(`[MOCK CARD PROVIDER] Rechargement de ${amount} sur ${providerCardId}`);
  return { success: true, providerReference: `mock_topup_${crypto.randomBytes(6).toString('hex')}` };
}

async function freeze(providerCardId) {
  console.log(`[MOCK CARD PROVIDER] Gel de la carte ${providerCardId}`);
  return { success: true };
}

async function unfreeze(providerCardId) {
  console.log(`[MOCK CARD PROVIDER] Dégel de la carte ${providerCardId}`);
  return { success: true };
}

async function close(providerCardId) {
  console.log(`[MOCK CARD PROVIDER] Fermeture de la carte ${providerCardId}`);
  return { success: true };
}

async function getBalance(providerCardId) {
  return { balance: 0, currency: 'USD' };
}

// Dérive des chiffres stables à partir d'une graine - jamais aléatoire à
// chaque appel, pour qu'un numéro déjà révélé reste identique si
// l'utilisateur le consulte une seconde fois. Un vrai fournisseur renverrait
// ces informations depuis son propre coffre, jamais stockées ici.
function deterministicDigits(seed, count) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  let digits = '';
  let i = 0;
  while (digits.length < count) {
    digits += (parseInt(hash[i % hash.length], 16) % 10).toString();
    i++;
  }
  return digits.slice(0, count);
}

// Les 4 derniers chiffres reprennent ceux déjà affichés en permanence
// (maskedNumber) - jamais une incohérence entre la version masquée et la
// version révélée du même numéro.
async function getCardDetails(providerCardId, maskedNumber) {
  const last4 = maskedNumber?.match(/(\d{4})$/)?.[0] || deterministicDigits(`${providerCardId}:last4`, 4);
  const first12 = deterministicDigits(providerCardId, 12);
  const number = `${first12.slice(0, 4)} ${first12.slice(4, 8)} ${first12.slice(8, 12)} ${last4}`;
  const cvc = deterministicDigits(`${providerCardId}:cvc`, 3);
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 3);
  const expiryMonth = String(expiry.getMonth() + 1).padStart(2, '0');
  const expiryYear = String(expiry.getFullYear()).slice(-2);
  return { number, cvc, expiryMonth, expiryYear };
}

module.exports = { createCard, topUp, freeze, unfreeze, close, getBalance, getCardDetails };

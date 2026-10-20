// Sélection du fournisseur via variable d'environnement, même bascule que
// CARD_PROVIDER/SMS_PROVIDER : un seul point de changement le jour où un
// vrai partenaire (Orange Money, MTN Mobile Money, un processeur carte)
// est intégré.
const EXTERNAL_PAYMENT_PROVIDER = process.env.EXTERNAL_PAYMENT_PROVIDER || 'mock';
const provider = require(`./providers/${EXTERNAL_PAYMENT_PROVIDER}Provider`);

// Les 3 moyens qu'un payeur SANS compte FlexPay peut utiliser - sur un
// lien de paiement, ou via l'API d'un partenaire (voir
// paymentIntent.service.js). FlexPay lui-même n'y figure jamais : c'est
// le 4e moyen, toujours disponible, jamais listé ici (voir
// requireFlexPayAlwaysAvailable dans businessPaymentFields/paymentIntent).
const EXTERNAL_PAYMENT_METHODS = ['orange_money', 'mtn_momo', 'card'];

async function collect({ phone, amount, provider: method }) {
  return provider.collect({ phone, amount, provider: method });
}

async function payout({ phone, amount, provider: method }) {
  return provider.payout({ phone, amount, provider: method });
}

module.exports = { EXTERNAL_PAYMENT_METHODS, collect, payout };

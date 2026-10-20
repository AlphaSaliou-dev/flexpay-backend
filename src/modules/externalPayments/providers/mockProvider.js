const crypto = require('crypto');

// Simule une collecte Orange Money / MTN Mobile Money / carte bancaire :
// en réalité, le partenaire enverrait une requête USSD (mobile money) ou
// une autorisation (carte) au payeur, qui confirme de son côté (quelques
// secondes, parfois un échec si le solde est insuffisant). Ici, toujours
// un succès immédiat - aucun vrai appel réseau tant qu'un partenaire n'est
// pas branché (voir EXTERNAL_PAYMENT_PROVIDER dans externalPayments.service.js,
// même bascule que CARD_PROVIDER/SMS_PROVIDER).
async function collect({ phone, amount, provider }) {
  return {
    status: 'COMPLETED',
    providerReference: `MOCK-${provider.toUpperCase()}-${crypto.randomBytes(6).toString('hex')}`,
  };
}

// Symétrique de collect() mais dans l'autre sens : FlexPay pousse de
// l'argent vers un bénéficiaire sans compte FlexPay (paiement en masse),
// via son numéro mobile money ou sa carte. Même simulation.
async function payout({ phone, amount, provider }) {
  return {
    status: 'COMPLETED',
    providerReference: `MOCK-PAYOUT-${provider.toUpperCase()}-${crypto.randomBytes(6).toString('hex')}`,
  };
}

module.exports = { collect, payout };

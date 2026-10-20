// Taux en fraction décimale (0.015 = 1,5%). Centralisé pour que Payments
// et l'API B2B utilisent toujours la même source - jamais de taux codé
// en dur ailleurs.

const DEFAULT_MERCHANT_FEE_RATE = 0.015; // paiement marchand/institution (in-app)
const DEFAULT_API_FEE_RATE = 0.015;      // paiement via l'API B2B (MarketConnect, etc.)
const VIRTUAL_CARD_TOPUP_FEE_RATE = 0.025;

// Plus bas que le taux marchand : un lot de paiement en masse (salaires,
// per diem de terrain...) est un usage B2B à volume élevé, et des frais
// trop élevés sur ce type de paiement sont documentés comme un frein
// courant à l'adoption du mobile money pour la paie en Afrique de l'Ouest.
const DEFAULT_BULK_PAYOUT_FEE_RATE = 0.01;

// Taux décidé pour l'API pay-out (le partenaire pousse de l'argent VERS
// un utilisateur, ex: rembourser un client ou payer un livreur) - même
// logique tarifaire qu'un paiement en masse B2B à volume.
const DEFAULT_API_PAYOUT_FEE_RATE = 0.01;

// Retrait du wallet vers un opérateur mobile money - décision du
// 2026-10-18 : aligné sur le palier qu'Orange Money Guinée applique déjà
// à la majorité des montants réels (1%, grille de janvier 2025), et sur
// le taux déjà utilisé ailleurs dans FlexPay (paiement en masse, API
// pay-out) plutôt que d'introduire un taux de plus à retenir. À
// réévaluer une fois le vrai coût d'un partenaire (ex: NimbaPay) connu.
const DEFAULT_WITHDRAWAL_FEE_RATE = 0.01;

// Transfert P2P vers un destinataire SANS compte FlexPay (repli externe,
// voir wallet.service.js transfer()) - volontairement plus bas que le
// retrait : rester sur FlexPay (destinataire actif) reste 100% gratuit,
// seule la sortie réelle vers un autre opérateur est facturée, pour
// inciter à faire grossir le réseau FlexPay plutôt qu'à payer à chaque
// envoi (voir le bouton "Inviter" côté app/site).
const DEFAULT_EXTERNAL_TRANSFER_FEE_RATE = 0.005;

// businessProfile.feeRateOverride prime toujours sur le taux par défaut.
function getMerchantFeeRate(businessProfile) {
  const override = businessProfile?.feeRateOverride;
  return override != null ? Number(override) : DEFAULT_MERCHANT_FEE_RATE;
}

// Un ApiClient n'a pas son propre override direct : le taux suit celui du
// compte Business auquel il est rattaché, pour garder une seule source de
// vérité par partenaire (évite un taux différent entre son usage in-app
// et son usage via l'API, ce qui serait déroutant à expliquer).
function getApiFeeRate(businessProfile) {
  return getMerchantFeeRate(businessProfile);
}

// Même mécanisme d'override que le taux marchand : une institution qui a
// négocié un taux particulier le voit appliqué partout, paiement en masse
// inclus, plutôt que de gérer un deuxième override séparé pour la même
// négociation commerciale.
function getBulkPayoutFeeRate(businessProfile) {
  const override = businessProfile?.feeRateOverride;
  return override != null ? Number(override) : DEFAULT_BULK_PAYOUT_FEE_RATE;
}

function getApiPayoutFeeRate(businessProfile) {
  const override = businessProfile?.feeRateOverride;
  return override != null ? Number(override) : DEFAULT_API_PAYOUT_FEE_RATE;
}

// Un compte INDIVIDUAL n'a pas de businessProfile (undefined) : le taux
// par défaut s'applique toujours dans ce cas, override réservé aux
// comptes Business/Marchand qui négocient un taux particulier.
function getWithdrawalFeeRate(businessProfile) {
  const override = businessProfile?.feeRateOverride;
  return override != null ? Number(override) : DEFAULT_WITHDRAWAL_FEE_RATE;
}

function getExternalTransferFeeRate(businessProfile) {
  const override = businessProfile?.feeRateOverride;
  return override != null ? Number(override) : DEFAULT_EXTERNAL_TRANSFER_FEE_RATE;
}

module.exports = {
  DEFAULT_MERCHANT_FEE_RATE,
  DEFAULT_API_FEE_RATE,
  VIRTUAL_CARD_TOPUP_FEE_RATE,
  DEFAULT_BULK_PAYOUT_FEE_RATE,
  DEFAULT_API_PAYOUT_FEE_RATE,
  DEFAULT_WITHDRAWAL_FEE_RATE,
  DEFAULT_EXTERNAL_TRANSFER_FEE_RATE,
  getMerchantFeeRate,
  getApiFeeRate,
  getBulkPayoutFeeRate,
  getApiPayoutFeeRate,
  getWithdrawalFeeRate,
  getExternalTransferFeeRate,
};

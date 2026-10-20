// Plafonds en GNF. Centralisés ici pour que Wallet, Payments et tout
// futur module s'y réfèrent de la même source - jamais de plafond codé
// en dur ailleurs dans l'app.
//
// Références de calibrage : plafonds publics Orange Money Guinée
// (compte non identifié : 2 550 000 GNF/jour ; compte vérifié :
// 50 000 000 GNF/jour, 15 000 000 GNF/transaction).

const INDIVIDUAL_LIMITS = {
  TIER_0: { perTransaction: 1_000_000, daily: 2_500_000, monthly: 15_000_000, maxBalance: 15_000_000 },
  TIER_1: { perTransaction: 5_000_000, daily: 10_000_000, monthly: 40_000_000, maxBalance: 40_000_000 },
  TIER_2: { perTransaction: 15_000_000, daily: 50_000_000, monthly: 300_000_000, maxBalance: 300_000_000 },
};

const BUSINESS_LIMITS_STANDARD = {
  perTransaction: 50_000_000,
  daily: 200_000_000,
  monthly: 2_000_000_000,
  maxBalance: 2_000_000_000,
};

// Plafonds d'un compte MERCHANT (palier allégé, sans RCCM/NIF vérifiés) -
// volontairement entre le Particulier Tier 2 et l'Entreprise standard :
// aucun registre légal n'a été vérifié, seule l'identité de la personne
// (KYC Tier 2) l'a été, donc le plafond ne doit pas atteindre celui d'une
// structure dont l'existence légale a été contrôlée. Un commerce qui
// dépasse durablement ces montants a de toute façon intérêt à passer
// Entreprise pour débloquer paiement de masse et API.
const MERCHANT_LIMITS_STANDARD = {
  perTransaction: 20_000_000,
  daily: 80_000_000,
  monthly: 500_000_000,
  maxBalance: 500_000_000,
};

// Retourne les plafonds applicables à un utilisateur donné.
// user: { accountType, kycProfile?: { tier }, businessProfile?: { customMonthlyLimit, customMaxBalance } }
function getLimitsForUser(user) {
  if (user.accountType === 'BUSINESS' || user.accountType === 'MERCHANT') {
    const standard = user.accountType === 'BUSINESS' ? BUSINESS_LIMITS_STANDARD : MERCHANT_LIMITS_STANDARD;
    const customMonthly = user.businessProfile?.customMonthlyLimit;
    const customMax = user.businessProfile?.customMaxBalance;
    return {
      ...standard,
      monthly: customMonthly ? Number(customMonthly) : standard.monthly,
      maxBalance: customMax ? Number(customMax) : standard.maxBalance,
    };
  }

  const tier = user.kycProfile?.tier || 'TIER_0';
  return INDIVIDUAL_LIMITS[tier];
}

module.exports = { INDIVIDUAL_LIMITS, BUSINESS_LIMITS_STANDARD, MERCHANT_LIMITS_STANDARD, getLimitsForUser };

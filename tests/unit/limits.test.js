const { getLimitsForUser, INDIVIDUAL_LIMITS, BUSINESS_LIMITS_STANDARD, MERCHANT_LIMITS_STANDARD } = require('../../src/config/limits');

describe('getLimitsForUser', () => {
  test('retourne les plafonds Tier 0 par défaut si aucun profil KYC', () => {
    const limits = getLimitsForUser({ accountType: 'INDIVIDUAL' });
    expect(limits).toEqual(INDIVIDUAL_LIMITS.TIER_0);
  });

  test('retourne les plafonds du palier KYC correct', () => {
    const limits = getLimitsForUser({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    expect(limits).toEqual(INDIVIDUAL_LIMITS.TIER_2);
  });

  test('le solde max est toujours égal au plafond mensuel du palier (règle produit)', () => {
    for (const tier of Object.keys(INDIVIDUAL_LIMITS)) {
      expect(INDIVIDUAL_LIMITS[tier].maxBalance).toBe(INDIVIDUAL_LIMITS[tier].monthly);
    }
  });

  test('un compte Business sans profil personnalisé reçoit les plafonds standards', () => {
    const limits = getLimitsForUser({ accountType: 'BUSINESS' });
    expect(limits).toEqual(BUSINESS_LIMITS_STANDARD);
  });

  test('un compte Business avec limite mensuelle négociée l\'utilise à la place du standard', () => {
    const limits = getLimitsForUser({
      accountType: 'BUSINESS',
      businessProfile: { customMonthlyLimit: 5_000_000_000 },
    });
    expect(limits.monthly).toBe(5_000_000_000);
    // Les autres plafonds restent au standard - une limite négociée ne change qu'elle-même.
    expect(limits.perTransaction).toBe(BUSINESS_LIMITS_STANDARD.perTransaction);
  });

  test('un compte Business avec solde max négocié l\'utilise à la place du standard', () => {
    const limits = getLimitsForUser({
      accountType: 'BUSINESS',
      businessProfile: { customMaxBalance: 9_000_000_000 },
    });
    expect(limits.maxBalance).toBe(9_000_000_000);
  });

  test('un compte MERCHANT reçoit un plafond intermédiaire, distinct du standard Business', () => {
    const limits = getLimitsForUser({ accountType: 'MERCHANT' });
    expect(limits).toEqual(MERCHANT_LIMITS_STANDARD);
    expect(limits.perTransaction).toBeLessThan(BUSINESS_LIMITS_STANDARD.perTransaction);
    expect(limits.monthly).toBeLessThan(BUSINESS_LIMITS_STANDARD.monthly);
  });

  test('un compte MERCHANT avec limite négociée l\'utilise à la place du standard Marchand', () => {
    const limits = getLimitsForUser({
      accountType: 'MERCHANT',
      businessProfile: { customMonthlyLimit: 700_000_000 },
    });
    expect(limits.monthly).toBe(700_000_000);
    expect(limits.perTransaction).toBe(MERCHANT_LIMITS_STANDARD.perTransaction);
  });

  test('les plafonds progressent strictement avec le palier (jamais de régression)', () => {
    const tiers = ['TIER_0', 'TIER_1', 'TIER_2'];
    for (let i = 1; i < tiers.length; i++) {
      const prev = INDIVIDUAL_LIMITS[tiers[i - 1]];
      const curr = INDIVIDUAL_LIMITS[tiers[i]];
      expect(curr.perTransaction).toBeGreaterThan(prev.perTransaction);
      expect(curr.daily).toBeGreaterThan(prev.daily);
      expect(curr.monthly).toBeGreaterThan(prev.monthly);
    }
  });
});

const { getMerchantFeeRate, getApiFeeRate, DEFAULT_MERCHANT_FEE_RATE } = require('../../src/config/fees');

describe('getMerchantFeeRate', () => {
  test('retourne le taux par défaut sans profil Business', () => {
    expect(getMerchantFeeRate(null)).toBe(DEFAULT_MERCHANT_FEE_RATE);
    expect(getMerchantFeeRate(undefined)).toBe(DEFAULT_MERCHANT_FEE_RATE);
  });

  test('retourne le taux par défaut si aucun override négocié', () => {
    expect(getMerchantFeeRate({ feeRateOverride: null })).toBe(DEFAULT_MERCHANT_FEE_RATE);
  });

  test('retourne le taux négocié quand il est présent', () => {
    expect(getMerchantFeeRate({ feeRateOverride: 0.008 })).toBe(0.008);
  });

  test('un taux négocié à zéro est bien appliqué (pas confondu avec "absent")', () => {
    // Piège classique : `0` est falsy en JS - si le code faisait
    // `override || DEFAULT`, un partenaire à 0% de commission se
    // retrouverait facturé au taux standard par erreur.
    expect(getMerchantFeeRate({ feeRateOverride: 0 })).toBe(0);
  });
});

describe('getApiFeeRate', () => {
  test('suit toujours le même taux que le paiement marchand in-app (une seule source de vérité par partenaire)', () => {
    const profile = { feeRateOverride: 0.011 };
    expect(getApiFeeRate(profile)).toBe(getMerchantFeeRate(profile));
  });
});

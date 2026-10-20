process.env.OTP_LENGTH = '6';
process.env.OTP_EXPIRES_MINUTES = '5';

const { generateOtpCode, hashOtpCode, verifyOtpCode, otpExpiryDate } = require('../../src/utils/otp');

describe('generateOtpCode', () => {
  test('génère toujours un code de la longueur configurée (avec zéros de tête si besoin)', () => {
    for (let i = 0; i < 30; i++) {
      const code = generateOtpCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashOtpCode / verifyOtpCode', () => {
  test('un code haché puis vérifié avec la même valeur est accepté', async () => {
    const code = '483920';
    const hash = await hashOtpCode(code);
    await expect(verifyOtpCode(code, hash)).resolves.toBe(true);
  });

  test('un mauvais code est rejeté', async () => {
    const hash = await hashOtpCode('483920');
    await expect(verifyOtpCode('000000', hash)).resolves.toBe(false);
  });

  test('le code n\'est jamais stocké en clair dans son propre hash', async () => {
    const code = '483920';
    const hash = await hashOtpCode(code);
    expect(hash).not.toContain(code);
  });
});

describe('otpExpiryDate', () => {
  test('retourne une date dans le futur, cohérente avec OTP_EXPIRES_MINUTES', () => {
    const before = Date.now();
    const expiry = otpExpiryDate();
    const diffMinutes = (expiry.getTime() - before) / 60000;
    expect(diffMinutes).toBeGreaterThan(4.9);
    expect(diffMinutes).toBeLessThan(5.1);
  });
});

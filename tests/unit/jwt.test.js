process.env.JWT_ACCESS_SECRET = 'test_secret';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';

const { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } = require('../../src/utils/jwt');

describe('access token', () => {
  test('un token signé peut être vérifié et contient le bon utilisateur', () => {
    const token = signAccessToken({ id: 'user-123', phone: '+224620000000' });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('user-123');
    expect(payload.phone).toBe('+224620000000');
  });

  test('un token altéré est rejeté', () => {
    const token = signAccessToken({ id: 'user-123', phone: '+224620000000' });
    const tampered = token.slice(0, -3) + 'xyz';
    expect(() => verifyAccessToken(tampered)).toThrow();
  });
});

describe('refresh token', () => {
  test('le token brut et son hash ne sont jamais identiques (le brut ne doit jamais finir en base tel quel)', () => {
    const { raw, hash } = generateRefreshToken();
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64); // SHA-256 en hexadécimal
  });

  test('deux appels génèrent toujours des tokens différents (pas de collision prévisible)', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.raw).not.toBe(b.raw);
  });

  test('hasher le même token brut produit toujours le même hash (nécessaire pour le retrouver en base)', () => {
    const { raw, hash } = generateRefreshToken();
    expect(hashRefreshToken(raw)).toBe(hash);
  });
});

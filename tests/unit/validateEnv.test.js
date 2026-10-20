const { validateEnv, EnvValidationError } = require('../../src/config/validateEnv');

function validEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a-real-secret',
    JWT_REFRESH_SECRET: 'another-real-secret',
    JWT_ADMIN_SECRET: 'yet-another-real-secret',
    NODE_ENV: 'development',
    ...overrides,
  };
}

describe('validateEnv', () => {
  test('accepte une configuration complète et valide', () => {
    expect(() => validateEnv(validEnv())).not.toThrow();
  });

  test('rejette une configuration où DATABASE_URL est manquant', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => validateEnv(env)).toThrow(EnvValidationError);
  });

  test('rejette une configuration où un secret JWT est manquant', () => {
    const env = validEnv();
    delete env.JWT_ADMIN_SECRET;
    expect(() => validateEnv(env)).toThrow(EnvValidationError);
  });

  test('liste précisément quel(s) champ(s) posent problème', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    delete env.JWT_ACCESS_SECRET;
    try {
      validateEnv(env);
      fail('aurait dû lever une erreur');
    } catch (err) {
      expect(err.details.DATABASE_URL).toBeDefined();
      expect(err.details.JWT_ACCESS_SECRET).toBeDefined();
      expect(err.details.JWT_ADMIN_SECRET).toBeUndefined(); // celui-ci était fourni, ne doit pas apparaître
    }
  });

  test('en développement, une valeur placeholder est tolérée', () => {
    const env = validEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'change_me_in_production' });
    expect(() => validateEnv(env)).not.toThrow();
  });

  test('en production, un secret encore sur sa valeur placeholder est rejeté', () => {
    const env = validEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change_me_in_production' });
    expect(() => validateEnv(env)).toThrow(/valeur par défaut/);
  });

  test('en production, des secrets correctement changés passent la validation', () => {
    const env = validEnv({ NODE_ENV: 'production' });
    expect(() => validateEnv(env)).not.toThrow();
  });
});

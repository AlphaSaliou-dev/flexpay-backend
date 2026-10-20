const mockSentryInit = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  init: (...args) => mockSentryInit(...args),
  captureException: (...args) => mockCaptureException(...args),
}));

describe('logger - censure des données sensibles', () => {
  let originalWrite;
  let captured;

  beforeEach(() => {
    jest.resetModules();
    captured = [];
    originalWrite = process.stdout.write;
    // Pino écrit directement sur stdout (pas via console.log) - on
    // intercepte à ce niveau pour capturer le JSON réellement émis,
    // pas une version qu'on suppose ou qu'on mocke à distance.
    process.stdout.write = (chunk) => {
      captured.push(chunk.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    delete process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });

  test('censure un mot de passe présent dans les données de log', () => {
    process.env.NODE_ENV = 'production'; // pour désactiver le mode silencieux du test et le transport pretty
    const { logger } = require('../../src/utils/logger');

    logger.info({ password: 'motdepasse123', phone: '+224620000000' }, 'test log');

    const entry = JSON.parse(captured[0]);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.phone).toBe('+224620000000'); // les champs non sensibles restent intacts
  });

  test('censure un code OTP et un token d\'accès', () => {
    process.env.NODE_ENV = 'production';
    const { logger } = require('../../src/utils/logger');

    logger.info({ otpCode: '123456', accessToken: 'eyJ...secret' }, 'test log');

    const entry = JSON.parse(captured[0]);
    expect(entry.otpCode).toBe('[REDACTED]');
    expect(entry.accessToken).toBe('[REDACTED]');
  });

  test('censure une clé API même imbriquée dans un sous-objet', () => {
    process.env.NODE_ENV = 'production';
    const { logger } = require('../../src/utils/logger');

    logger.info({ apiClient: { name: 'MarketConnect', apiKey: 'fp_live_secret' } }, 'test log');

    const entry = JSON.parse(captured[0]);
    expect(entry.apiClient.apiKey).toBe('[REDACTED]');
    expect(entry.apiClient.name).toBe('MarketConnect');
  });
});

describe('logger - suivi d\'erreurs Sentry conditionnel', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.SENTRY_DSN;
  });

  test('sans SENTRY_DSN configuré, Sentry reste inactif (jamais initialisé, jamais appelé)', () => {
    jest.resetModules();
    delete process.env.SENTRY_DSN;

    const { logError, Sentry } = require('../../src/utils/logger');
    expect(Sentry).toBeNull();

    expect(() => logError('test-context', new Error('boom'))).not.toThrow();
    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('avec SENTRY_DSN configuré, logError transmet bien l\'erreur à Sentry', () => {
    jest.resetModules();
    process.env.SENTRY_DSN = 'https://fake@sentry.example.com/1';

    const { logError } = require('../../src/utils/logger');
    const err = new Error('boom');

    logError('test-context', err, { extra: 'info' });

    expect(mockSentryInit).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(err, { tags: { context: 'test-context' }, extra: { extra: 'info' } });
  });

  test('logError logue TOUJOURS localement, que Sentry soit configuré ou non', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.SENTRY_DSN;

    const captured = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { captured.push(chunk.toString()); return true; };

    const { logError } = require('../../src/utils/logger');
    logError('test-context', new Error('boom'));

    process.stdout.write = originalWrite;
    process.env.NODE_ENV = 'test';

    expect(captured.length).toBeGreaterThan(0);
    const entry = JSON.parse(captured[0]);
    expect(entry.context).toBe('test-context');
  });
});

const mockScanBuffer = jest.fn();
jest.mock('../../src/modules/files/scanProviders/clamavProvider', () => ({
  scanBuffer: (...args) => mockScanBuffer(...args),
}));

describe('virusScan.service - politique de sécurité', () => {
  let originalNodeEnv;
  let originalAllowUnscanned;

  beforeEach(() => {
    jest.resetModules();
    mockScanBuffer.mockReset();
    originalNodeEnv = process.env.NODE_ENV;
    originalAllowUnscanned = process.env.ALLOW_UNSCANNED_UPLOADS;
    process.env.VIRUS_SCAN_PROVIDER = 'clamav';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ALLOW_UNSCANNED_UPLOADS = originalAllowUnscanned;
  });

  test('un fichier propre (clean: true) est autorisé', async () => {
    mockScanBuffer.mockResolvedValue({ clean: true, signature: null });
    const { assertFileIsSafe } = require('../../src/modules/files/virusScan.service');

    await expect(assertFileIsSafe(Buffer.from('ok'))).resolves.toBe(true);
  });

  test('un fichier infecté (clean: false) est TOUJOURS rejeté, quel que soit l\'environnement', async () => {
    mockScanBuffer.mockResolvedValue({ clean: false, signature: 'EICAR-Test-Signature' });
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNSCANNED_UPLOADS = 'true'; // même avec ce flag, un virus détecté reste rejeté
    const { assertFileIsSafe, VirusDetectedError } = require('../../src/modules/files/virusScan.service');

    await expect(assertFileIsSafe(Buffer.from('bad'))).rejects.toThrow(VirusDetectedError);
  });

  test('en développement avec ALLOW_UNSCANNED_UPLOADS=true, un scan indisponible (clean: null) est toléré', async () => {
    mockScanBuffer.mockResolvedValue({ clean: null, signature: null, error: 'ClamAV non installé' });
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNSCANNED_UPLOADS = 'true';
    const { assertFileIsSafe } = require('../../src/modules/files/virusScan.service');

    await expect(assertFileIsSafe(Buffer.from('?'))).resolves.toBe(true);
  });

  test('en développement SANS le flag ALLOW_UNSCANNED_UPLOADS, un scan indisponible est rejeté', async () => {
    mockScanBuffer.mockResolvedValue({ clean: null, signature: null, error: 'ClamAV non installé' });
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_UNSCANNED_UPLOADS;
    const { assertFileIsSafe, ScanUnavailableError } = require('../../src/modules/files/virusScan.service');

    await expect(assertFileIsSafe(Buffer.from('?'))).rejects.toThrow(ScanUnavailableError);
  });

  test('en PRODUCTION, un scan indisponible est TOUJOURS rejeté, même avec ALLOW_UNSCANNED_UPLOADS=true', async () => {
    // Le point de sécurité le plus important de ce fichier : le flag de
    // confort pour le développement ne doit jamais avoir d'effet en prod.
    mockScanBuffer.mockResolvedValue({ clean: null, signature: null, error: 'ClamAV non installé' });
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNSCANNED_UPLOADS = 'true';
    const { assertFileIsSafe, ScanUnavailableError } = require('../../src/modules/files/virusScan.service');

    await expect(assertFileIsSafe(Buffer.from('?'))).rejects.toThrow(ScanUnavailableError);
  });
});

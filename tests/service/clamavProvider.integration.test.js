const path = require('path');
const { execFileSync } = require('child_process');

const EICAR_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const TEST_SIGNATURE_DB = path.join(__dirname, '../fixtures/eicar-test.ndb');

function isClamscanAvailable() {
  try {
    execFileSync('which', ['clamscan'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const clamscanAvailable = isClamscanAvailable();

// Ce test appelle le VRAI binaire clamscan, pas un mock - c'est un test
// d'intégration, volontairement séparé des tests unitaires habituels de
// ce projet. Protégé par un describe.skip conditionnel : si `clamscan`
// n'est pas installé sur la machine qui exécute la suite (ex: un poste
// de dev sans ClamAV, ou certains environnements CI), ce bloc est
// silencieusement ignoré plutôt que de faire échouer toute la suite pour
// une dépendance système absente - mais il tourne réellement dans les
// environnements où ClamAV est présent (dont celui utilisé pour
// construire ce projet).
const describeIfClamAvailable = clamscanAvailable ? describe : describe.skip;

describeIfClamAvailable('clamavProvider (intégration réelle avec clamscan)', () => {
  let scanBuffer;

  beforeAll(() => {
    process.env.CLAMAV_CUSTOM_DB_PATH = TEST_SIGNATURE_DB;
    scanBuffer = require('../../src/modules/files/scanProviders/clamavProvider').scanBuffer;
  });

  test('détecte réellement le fichier de test EICAR (standard de l\'industrie antivirus)', async () => {
    const result = await scanBuffer(Buffer.from(EICAR_STRING));
    expect(result.clean).toBe(false);
    expect(result.signature).toMatch(/EICAR/);
  }, 10000);

  test('laisse passer un fichier parfaitement normal', async () => {
    const result = await scanBuffer(Buffer.from('Ceci est un document PDF tout à fait normal.'));
    expect(result.clean).toBe(true);
    expect(result.signature).toBeNull();
  }, 10000);

  test('nettoie systématiquement son fichier temporaire après le scan', async () => {
    const fs = require('fs/promises');
    const os = require('os');
    const before = await fs.readdir(os.tmpdir());
    const flexpayTmpDirsBefore = before.filter((f) => f.startsWith('flexpay-scan-')).length;

    await scanBuffer(Buffer.from('test'));

    const after = await fs.readdir(os.tmpdir());
    const flexpayTmpDirsAfter = after.filter((f) => f.startsWith('flexpay-scan-')).length;

    // Aucun dossier temporaire supplémentaire ne doit rester après le scan.
    expect(flexpayTmpDirsAfter).toBe(flexpayTmpDirsBefore);
  }, 10000);
});

if (!clamscanAvailable) {
  test('(clamscan non disponible sur cette machine - tests d\'intégration ClamAV ignorés)', () => {
    expect(true).toBe(true);
  });
}

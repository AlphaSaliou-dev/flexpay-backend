const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Chemin vers une base de signatures personnalisée (utilisée en
// développement quand la base officielle ClamAV n'est pas disponible -
// voir scanProvider.interface.js). En production, laisser vide : ClamAV
// utilisera automatiquement /var/lib/clamav (chargé par freshclam).
const CUSTOM_SIGNATURE_DB = process.env.CLAMAV_CUSTOM_DB_PATH || null;

// clamscan a besoin d'un vrai fichier sur disque, pas d'un buffer en
// mémoire - on écrit dans un dossier temporaire dédié, jamais dans le
// dossier de stockage final, et on nettoie systématiquement après scan
// (y compris en cas d'erreur, via finally).
async function scanBuffer(buffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flexpay-scan-'));
  const tmpFile = path.join(tmpDir, crypto.randomBytes(8).toString('hex'));

  try {
    await fs.writeFile(tmpFile, buffer);

    const args = [];
    if (CUSTOM_SIGNATURE_DB) args.push('-d', CUSTOM_SIGNATURE_DB);
    args.push('--no-summary', tmpFile);

    return await new Promise((resolve) => {
      execFile('clamscan', args, (error, stdout) => {
        // clamscan renvoie un code de sortie 1 (une "erreur" pour
        // execFile) quand un virus est détecté - ce n'est pas une
        // vraie erreur d'exécution, juste sa façon de signaler un hit.
        const infected = /FOUND$/m.test(stdout);
        const match = stdout.match(/:\s(.+)\sFOUND/);

        if (error && !infected) {
          // Erreur réelle (ex: pas de base de signatures chargée du
          // tout) - on ne bloque jamais un upload sur une panne du
          // scanner, mais on ne le déclare jamais "clean" non plus.
          resolve({ clean: null, signature: null, error: error.message });
          return;
        }

        resolve({ clean: !infected, signature: infected ? match?.[1] || 'inconnu' : null });
      });
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { scanBuffer };

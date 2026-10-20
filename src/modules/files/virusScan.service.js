const SCAN_PROVIDER = process.env.VIRUS_SCAN_PROVIDER || 'clamav';
const provider = require(`./scanProviders/${SCAN_PROVIDER}Provider`);

class VirusDetectedError extends Error {
  constructor(signature) {
    super(`Fichier rejeté : signature virale détectée (${signature})`);
    this.statusCode = 422;
    this.signature = signature;
  }
}

class ScanUnavailableError extends Error {
  constructor(reason) {
    super(`Scan antivirus indisponible, upload refusé par prudence : ${reason}`);
    this.statusCode = 503;
  }
}

// Politique de sécurité, volontairement stricte par défaut :
//   - clean === true  -> upload autorisé
//   - clean === false -> toujours rejeté, sans exception, quel que soit
//     l'environnement
//   - clean === null (scanner indisponible/en panne) -> rejeté en
//     production par défaut (on ne stocke jamais un fichier "peut-être
//     infecté" juste parce que l'antivirus était en panne au mauvais
//     moment) ; autorisé en développement uniquement si
//     ALLOW_UNSCANNED_UPLOADS=true est explicitement positionné, pour ne
//     pas bloquer un poste de dev sans ClamAV installé.
async function assertFileIsSafe(buffer) {
  const result = await provider.scanBuffer(buffer);

  if (result.clean === false) {
    throw new VirusDetectedError(result.signature);
  }

  if (result.clean === null) {
    const allowUnscanned = process.env.ALLOW_UNSCANNED_UPLOADS === 'true';
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction || !allowUnscanned) {
      throw new ScanUnavailableError(result.error || 'résultat indéterminé');
    }
  }

  return true;
}

module.exports = { assertFileIsSafe, VirusDetectedError, ScanUnavailableError };

// Utilisé quand ClamAV n'est pas installé sur la machine (ex: poste de
// développement sans le binaire clamscan). Renvoie toujours "inconnu",
// jamais "propre" par défaut - virusScan.service.js applique ensuite sa
// propre politique selon l'environnement (voir ALLOW_UNSCANNED_UPLOADS).
async function scanBuffer(buffer) {
  return { clean: null, signature: null, error: 'Scan antivirus désactivé (VIRUS_SCAN_PROVIDER=disabled)' };
}

module.exports = { scanBuffer };

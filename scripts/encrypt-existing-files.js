// Migration unique : chiffre tout fichier déjà écrit sur le stockage
// AVANT l'introduction du chiffrement (voir files.service.js,
// encryption.js). Repère les lignes à traiter via encryptedAtRest=false
// (mis à false par défaut pour toute ligne existante au moment de la
// migration de schéma, jamais recalculé par contenu - impossible à
// détecter fiablement sur du binaire quelconque). Lit l'octet brut
// actuellement sur le disque, le chiffre, le réécrit, puis marque la
// ligne encryptedAtRest=true - jamais l'inverse, pour ne pas chiffrer
// deux fois un fichier déjà traité si le script est relancé par erreur.
const prisma = require('../src/config/db');
const { encryptBuffer } = require('../src/utils/encryption');

const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';
const storage = require(`../src/modules/files/storage/${STORAGE_PROVIDER}Storage`);

async function main() {
  const assets = await prisma.fileAsset.findMany({ where: { encryptedAtRest: false } });

  let migrated = 0;
  let failed = 0;

  for (const asset of assets) {
    try {
      const raw = await storage.read(asset.storageKey);
      await storage.save(encryptBuffer(raw), asset.storageKey);
      await prisma.fileAsset.update({ where: { id: asset.id }, data: { encryptedAtRest: true } });
      migrated += 1;
    } catch (err) {
      failed += 1;
      console.error(`Échec pour ${asset.id} (${asset.storageKey}) :`, err.message);
    }
  }

  console.log(`${migrated} fichier(s) chiffré(s), ${failed} échec(s), ${assets.length} examiné(s) au total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Échec de la migration :', err);
  process.exit(1);
});

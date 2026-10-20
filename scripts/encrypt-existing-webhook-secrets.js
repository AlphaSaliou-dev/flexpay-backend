// Migration unique : chiffre tout secret webhook existant écrit AVANT
// l'introduction du chiffrement (voir encryption.js) - sans ce script,
// ces anciens secrets en clair deviendraient illisibles (decrypt()
// échouerait) dès le premier envoi de webhook après le déploiement de ce
// changement. Détection : une valeur déjà chiffrée a exactement 3
// segments séparés par ':' (iv:authTag:ciphertext) ; un ancien secret en
// clair ("whsec_...") n'en a aucun - jamais rechiffrer une valeur déjà
// chiffrée.
const prisma = require('../src/config/db');
const { encrypt } = require('../src/utils/encryption');

async function main() {
  const clients = await prisma.apiClient.findMany({ where: { webhookSecret: { not: null } } });

  let migrated = 0;
  let alreadyEncrypted = 0;

  for (const client of clients) {
    if (client.webhookSecret.split(':').length === 3) {
      alreadyEncrypted += 1;
      continue;
    }
    await prisma.apiClient.update({
      where: { id: client.id },
      data: { webhookSecret: encrypt(client.webhookSecret) },
    });
    migrated += 1;
  }

  console.log(`${migrated} secret(s) webhook chiffré(s), ${alreadyEncrypted} déjà chiffré(s), ${clients.length} examiné(s) au total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Échec de la migration :', err);
  process.exit(1);
});

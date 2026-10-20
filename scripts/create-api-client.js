// Usage : node scripts/create-api-client.js "MarketConnect" <businessUserId>
//
// Génère une clé API pour un partenaire B2B et l'affiche UNE SEULE FOIS
// dans la console - elle n'est jamais récupérable ensuite (seul son hash
// est stocké). À remplacer par un écran admin sécurisé avant production.

require('dotenv').config();
const prisma = require('../src/config/db');
const { generateApiKey } = require('../src/modules/payments/apiKey.util');

async function main() {
  const [name, businessUserId] = process.argv.slice(2);

  if (!name || !businessUserId) {
    console.error('Usage: node scripts/create-api-client.js "<Nom>" <businessUserId>');
    process.exit(1);
  }

  const business = await prisma.user.findUnique({ where: { id: businessUserId } });
  if (!business || business.accountType !== 'BUSINESS') {
    console.error("Ce userId n'est pas un compte Business valide.");
    process.exit(1);
  }

  const { raw, hash, prefix } = generateApiKey('live');

  await prisma.apiClient.create({
    data: { name, businessUserId, apiKeyHash: hash, apiKeyPrefix: prefix },
  });

  console.log(`Partenaire "${name}" créé.`);
  console.log(`Clé API (à noter maintenant, elle ne sera plus jamais affichée) :`);
  console.log(raw);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

// ⚠️ USAGE TEST UNIQUEMENT — ces entrées sont entièrement fictives,
// inventées pour vérifier que le filtrage fonctionne techniquement. Ce
// N'EST PAS une liste de sanctions réelle. Avant toute mise en
// production, remplacer par une vraie source de données :
//   - OFAC SDN List (US Treasury) : sanctionslistservice.ofac.treas.gov
//   - Liste consolidée UE : webgate.ec.europa.eu/fsd
//   - Liste ONU : scsanctions.un.org
//   - Ou un fournisseur spécialisé (ComplyAdvantage, Refinitiv World-Check)
//     qui maintient et met à jour ces listes automatiquement - recommandé
//     pour une vraie fintech, la maintenance manuelle de ces listes est
//     un travail à temps plein.
//
// Usage : node scripts/seed-sanctions-test-data.js

require('dotenv').config();
const prisma = require('../src/config/db');

const FICTIONAL_TEST_ENTRIES = [
  { fullName: 'Jean Test Sanctionné', aliases: ['J. Test Sanctionné'], type: 'SANCTIONS', source: 'Test fictif' },
  { fullName: 'Entreprise Fictive SARL', aliases: ['Fictive SARL'], type: 'SANCTIONS', source: 'Test fictif' },
  { fullName: 'Personnalité Politique Exemple', aliases: [], type: 'PEP', source: 'Test fictif' },
];

async function main() {
  for (const entry of FICTIONAL_TEST_ENTRIES) {
    await prisma.sanctionedEntity.create({ data: entry });
  }
  console.log(`${FICTIONAL_TEST_ENTRIES.length} entrées de test créées (FICTIVES - ne pas utiliser en production).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// Usage : node scripts/create-admin.js "Nom Complet" email@flexpay.gn motdepasse SUPERADMIN
//
// Volontairement en CLI et non en route API : un compte admin ne doit
// jamais pouvoir être créé par un appel HTTP, même protégé - ça évite
// toute une classe de failles (élévation de privilèges via un bug de
// validation, clé API compromise, etc.).

require('dotenv').config();
const argon2 = require('argon2');
const prisma = require('../src/config/db');

const VALID_ROLES = ['SUPPORT', 'COMPLIANCE', 'SUPERADMIN'];

async function main() {
  const [fullName, email, password, role] = process.argv.slice(2);

  if (!fullName || !email || !password || !VALID_ROLES.includes(role)) {
    console.error(`Usage: node scripts/create-admin.js "<Nom>" <email> <mot_de_passe> <${VALID_ROLES.join('|')}>`);
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.error('Un admin avec cet email existe déjà.');
    process.exit(1);
  }

  const passwordHash = await argon2.hash(password);

  await prisma.adminUser.create({
    data: { fullName, email, passwordHash, role },
  });

  console.log(`Compte admin créé : ${email} (${role})`);
  console.log(`La configuration de la double authentification (2FA) sera demandée à la première connexion.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

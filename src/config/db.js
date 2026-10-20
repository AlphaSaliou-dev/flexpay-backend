const { PrismaClient } = require('@prisma/client');

// Une seule instance de PrismaClient réutilisée dans toute l'app
// (évite d'épuiser les connexions PostgreSQL en développement avec hot-reload)
const prisma = global.__flexpay_prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__flexpay_prisma = prisma;
}

module.exports = prisma;

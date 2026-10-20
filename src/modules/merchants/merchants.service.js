const prisma = require('../../config/db');

// Champs exposés publiquement (avant même la connexion pour un lien de
// paiement) : nom + id pour identifier le marchand et payer, logo pour le
// reconnaître visuellement, catégorie/localisation pour parcourir le
// catalogue - jamais le RCCM, le NIF ou toute autre donnée de dossier.
// C'est un annuaire public d'usage, pas une vue interne.
const PUBLIC_SELECT = {
  userId: true,
  businessName: true,
  receiptLogoUrl: true,
  category: true,
  location: true,
};

function toPublicMerchant(b) {
  return {
    businessUserId: b.userId,
    businessName: b.businessName,
    logoUrl: b.receiptLogoUrl,
    category: b.category,
    location: b.location,
  };
}

async function searchMerchants(query) {
  const businessProfiles = await prisma.businessProfile.findMany({
    where: {
      reviewStatus: 'APPROVED',
      businessName: { contains: query, mode: 'insensitive' },
    },
    take: 20,
    select: PUBLIC_SELECT,
  });

  return businessProfiles.map(toPublicMerchant);
}

// Catalogue parcourable sans terme de recherche - complète searchMerchants
// pour l'écran "Catalogue des institutions" (on ne trouve pas ce dont on
// ignore l'orthographe exacte). Filtre optionnel par catégorie.
async function listMerchants({ category } = {}) {
  const businessProfiles = await prisma.businessProfile.findMany({
    where: {
      reviewStatus: 'APPROVED',
      ...(category ? { category } : {}),
    },
    take: 50,
    orderBy: { businessName: 'asc' },
    select: PUBLIC_SELECT,
  });

  return businessProfiles.map(toPublicMerchant);
}

module.exports = { searchMerchants, listMerchants };

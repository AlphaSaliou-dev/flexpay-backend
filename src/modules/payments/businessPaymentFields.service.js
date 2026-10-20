const prisma = require('../../config/db');

class BusinessFieldError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MAX_FIELDS_PER_BUSINESS = 10;
// Un compte Marchand a droit à 3 champs personnalisés (ex: "Table n°",
// "Nom du client", "Numéro de commande") - de quoi couvrir les besoins
// courants sans lui ouvrir tout l'outillage réservé à l'Entreprise.
const MAX_FIELDS_PER_MERCHANT = 3;

// Dérive une clé technique stable à partir du libellé humain (ex: "Nom de
// l'élève" -> "nom_de_leleve"). Utilisée comme clé dans les données
// personnalisées de chaque paiement - jamais affichée au payeur, qui ne
// voit que le libellé d'origine.
function slugifyLabel(label) {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function getBusinessProfileOrThrow(businessUserId) {
  const profile = await prisma.businessProfile.findUnique({
    where: { userId: businessUserId },
    include: { user: { select: { accountType: true } } },
  });
  if (!profile) throw new BusinessFieldError('Compte Business introuvable', 404);
  return profile;
}

// --- Gestion par l'institution elle-même (propriété vérifiée) --------------

async function listFieldsForOwner(businessUserId) {
  const profile = await getBusinessProfileOrThrow(businessUserId);
  return prisma.businessPaymentField.findMany({
    where: { businessProfileId: profile.id },
    orderBy: { order: 'asc' },
  });
}

async function createField(businessUserId, { label, required }) {
  const profile = await getBusinessProfileOrThrow(businessUserId);

  const maxFields = profile.user.accountType === 'MERCHANT' ? MAX_FIELDS_PER_MERCHANT : MAX_FIELDS_PER_BUSINESS;
  const existingCount = await prisma.businessPaymentField.count({ where: { businessProfileId: profile.id } });
  if (existingCount >= maxFields) {
    throw new BusinessFieldError(`Maximum ${maxFields} champ${maxFields > 1 ? 's' : ''} personnalisé${maxFields > 1 ? 's' : ''} par compte`, 400);
  }

  const fieldKey = slugifyLabel(label);
  if (!fieldKey) throw new BusinessFieldError('Libellé invalide', 400);

  const duplicate = await prisma.businessPaymentField.findUnique({
    where: { businessProfileId_fieldKey: { businessProfileId: profile.id, fieldKey } },
  });
  if (duplicate) throw new BusinessFieldError('Un champ similaire existe déjà', 409);

  return prisma.businessPaymentField.create({
    data: { businessProfileId: profile.id, label, fieldKey, required: required !== false, order: existingCount },
  });
}

async function updateField(businessUserId, fieldId, { label, required, order }) {
  const profile = await getBusinessProfileOrThrow(businessUserId);
  const field = await prisma.businessPaymentField.findUnique({ where: { id: fieldId } });

  if (!field || field.businessProfileId !== profile.id) {
    throw new BusinessFieldError('Champ introuvable', 404);
  }

  return prisma.businessPaymentField.update({
    where: { id: fieldId },
    data: {
      ...(label !== undefined ? { label, fieldKey: slugifyLabel(label) } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(order !== undefined ? { order } : {}),
    },
  });
}

async function deleteField(businessUserId, fieldId) {
  const profile = await getBusinessProfileOrThrow(businessUserId);
  const field = await prisma.businessPaymentField.findUnique({ where: { id: fieldId } });

  if (!field || field.businessProfileId !== profile.id) {
    throw new BusinessFieldError('Champ introuvable', 404);
  }

  await prisma.businessPaymentField.delete({ where: { id: fieldId } });
}

// --- Consultation publique (par le payeur, avant de payer) -----------------
// Pas de vérification de propriété ici - n'importe quel utilisateur qui
// s'apprête à payer ce marchand doit voir quels champs remplir.

async function listFieldsForPayer(businessUserId) {
  const profile = await prisma.businessProfile.findUnique({ where: { userId: businessUserId } });
  if (!profile || profile.reviewStatus !== 'APPROVED') return [];

  return prisma.businessPaymentField.findMany({
    where: { businessProfileId: profile.id },
    orderBy: { order: 'asc' },
    select: { id: true, label: true, fieldKey: true, required: true },
  });
}

// Vérifie que toutes les valeurs requises par l'institution sont bien
// fournies par le payeur - appelé depuis payments.service.js avant tout
// mouvement d'argent. Ne vérifie que la PRÉSENCE des champs requis,
// jamais leur contenu (une institution peut demander "Classe" sans que
// FlexPay ait à valider que la classe existe réellement).
async function assertCustomFieldsComplete(businessUserId, customFields = {}) {
  const fields = await listFieldsForPayer(businessUserId);
  const missing = fields.filter((f) => f.required && !customFields[f.fieldKey]?.trim());

  if (missing.length > 0) {
    throw new BusinessFieldError(
      `Champ(s) requis manquant(s) : ${missing.map((f) => f.label).join(', ')}`,
      400
    );
  }

  return fields;
}

// --- Personnalisation du reçu (logo + pied de page) -------------------------
// Contrairement aux champs, l'appartenance ici est directe : une
// institution ne configure jamais que SA propre image de marque.

async function getReceiptBranding(businessUserId) {
  const profile = await getBusinessProfileOrThrow(businessUserId);
  return {
    receiptLogoUrl: profile.receiptLogoUrl,
    receiptContactInfo: profile.receiptContactInfo,
    receiptFooterText: profile.receiptFooterText,
    // Déjà collectés au KYB (Entreprise uniquement) - affichés en lecture
    // seule sur l'écran de personnalisation pour que l'institution sache
    // qu'ils apparaîtront automatiquement sur ses reçus, sans ressaisie.
    rccmNumber: profile.rccmNumber,
    nifNumber: profile.nifNumber,
  };
}

async function setReceiptBranding(businessUserId, { receiptLogoUrl, receiptContactInfo, receiptFooterText }) {
  await getBusinessProfileOrThrow(businessUserId);
  return prisma.businessProfile.update({
    where: { userId: businessUserId },
    data: {
      ...(receiptLogoUrl !== undefined ? { receiptLogoUrl } : {}),
      ...(receiptContactInfo !== undefined ? { receiptContactInfo } : {}),
      ...(receiptFooterText !== undefined ? { receiptFooterText } : {}),
    },
  });
}

module.exports = {
  BusinessFieldError,
  MAX_FIELDS_PER_BUSINESS,
  MAX_FIELDS_PER_MERCHANT,
  slugifyLabel,
  listFieldsForOwner,
  createField,
  updateField,
  deleteField,
  listFieldsForPayer,
  assertCustomFieldsComplete,
  getReceiptBranding,
  setReceiptBranding,
};

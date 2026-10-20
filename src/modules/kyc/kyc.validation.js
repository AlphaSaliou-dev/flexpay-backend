const { z } = require('zod');

const ID_DOCUMENT_TYPES = ['CNI', 'PASSEPORT', 'PERMIS_CONDUIRE', 'CARTE_ELECTEUR'];

// Le module Files renvoie des chemins internes (/api/v1/files/{id}), pas
// des URLs absolues - l'accès est contrôlé par propriétaire, pas par
// obscurité. z.string().url() rejetterait systématiquement ce format
// (bug déjà corrigé une fois, réintroduit par une réécriture ultérieure
// de ce fichier - voir les champs ci-dessous qui en dépendent tous).
const fileUrlSchema = z
  .string()
  .regex(/^\/api\/v1\/files\/[a-zA-Z0-9-]+$/, 'Référence de fichier invalide');

// Tier 1 : déclaratif, aucun document
const submitTier1Schema = z.object({
  fullName: z.string().min(2).max(100),
  dateOfBirth: z.coerce.date(),
});

// Tier 2 : pièce d'identité officielle + selfie (vérification faciale).
// Les deux URLs pointent vers des fichiers déjà déposés sur le stockage
// sécurisé (flux d'upload séparé, module Files).
const submitTier2Schema = z.object({
  idDocumentType: z.enum(ID_DOCUMENT_TYPES),
  idDocumentNumber: z.string().min(3).max(50),
  idDocumentUrl: fileUrlSchema,
  selfieUrl: fileUrlSchema,
});

// Un bénéficiaire effectif (UBO) : toute personne physique qui possède ou
// contrôle réellement l'entreprise.
const uboSchema = z.object({
  fullName: z.string().min(2).max(100),
  ownershipPercentage: z.number().min(0).max(100),
  idDocumentUrl: fileUrlSchema,
});

// KYB - compte Business, tout est requis dès le départ, y compris au
// moins un bénéficiaire effectif (exigence AML standard).
const submitBusinessKycSchema = z.object({
  businessName: z.string().min(2).max(150),
  rccmNumber: z.string().min(3).max(50),
  nifNumber: z.string().min(3).max(50),
  legalRepName: z.string().min(2).max(100),
  legalRepIdDocumentUrl: fileUrlSchema,
  businessDocumentUrl: fileUrlSchema,
  ubos: z.array(uboSchema).min(1, 'Au moins un bénéficiaire effectif est requis'),
  // Affichées dans le catalogue public des marchands (voir merchants.service.js)
  // - optionnelles pour ne pas bloquer une institution qui ne s'y retrouve
  // pas encore dans les catégories proposées.
  category: z.string().min(2).max(50).optional(),
  location: z.string().min(2).max(100).optional(),
});

// Marchand - palier allégé, aucune pièce légale (voir kyc.service.js
// submitMerchantKyc pour le raisonnement).
const submitMerchantKycSchema = z.object({
  businessName: z.string().min(2).max(150),
  category: z.string().min(2).max(50).optional(),
  location: z.string().min(2).max(100).optional(),
});

module.exports = {
  ID_DOCUMENT_TYPES,
  submitTier1Schema,
  submitTier2Schema,
  uboSchema,
  submitBusinessKycSchema,
  submitMerchantKycSchema,
};

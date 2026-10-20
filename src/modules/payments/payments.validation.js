const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const payMerchantSchema = z.object({
  businessUserId: z.string().uuid(),
  amount: z.number().positive(),
  idempotencyKey: z.string().uuid(),
  reference: z.string().max(200).optional(), // ex: "Frais scolarité - Avril"
  customFields: z.record(z.string(), z.string().max(200)).optional(), // ex: { nom_de_leleve: "Mariama Camara" }
  pinCode: pinSchema, // consommé par requireTransactionPin
});

const setWebhookUrlSchema = z.object({
  webhookUrl: z.string().url(),
});

// FlexPay n'apparaît jamais dans cette liste - il n'est pas une option à
// cocher, il est toujours disponible pour tout partenaire (voir
// payments.service.setEnabledExternalMethods).
const setEnabledExternalMethodsSchema = z.object({
  enabledExternalMethods: z.array(z.enum(['orange_money', 'mtn_momo', 'card'])).max(3),
});

const createFieldSchema = z.object({
  label: z.string().min(2).max(60),
  required: z.boolean().default(true),
});

const updateFieldSchema = z.object({
  label: z.string().min(2).max(60).optional(),
  required: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
});

// Le module Files renvoie des chemins internes (/api/v1/files/{id}), pas
// des URLs absolues - l'accès est contrôlé par propriétaire, pas par
// obscurité. z.string().url() rejette systématiquement ce format (même
// bug déjà corrigé dans kyc.validation.js, voir son commentaire).
const fileUrlSchema = z
  .string()
  .regex(/^\/api\/v1\/files\/[a-zA-Z0-9-]+$/, 'Référence de fichier invalide');

const receiptBrandingSchema = z.object({
  receiptLogoUrl: fileUrlSchema.optional(),
  receiptContactInfo: z.string().max(200).optional(),
  receiptFooterText: z.string().max(500).optional(),
});

module.exports = {
  payMerchantSchema,
  setWebhookUrlSchema,
  setEnabledExternalMethodsSchema,
  createFieldSchema,
  updateFieldSchema,
  receiptBrandingSchema,
};

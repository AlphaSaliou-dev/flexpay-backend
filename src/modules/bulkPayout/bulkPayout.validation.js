const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const bulkPayoutItemSchema = z.object({
  phone: z.string().regex(/^\+224\d{8,9}$/),
  amount: z.number().positive(),
  reference: z.string().max(200).optional(),
});

// Choix UNIQUE pour tout le lot (pas par bénéficiaire - impossible à
// deviner depuis un simple numéro de téléphone) : si un numéro n'a pas de
// compte FlexPay actif, l'envoyer quand même via ce moyen externe plutôt
// que de faire échouer la ligne. Absent/null = comportement historique
// (FlexPay obligatoire, sinon la ligne échoue).
const createBulkPayoutSchema = z.object({
  items: z.array(bulkPayoutItemSchema).min(1),
  reference: z.string().max(200).optional(),
  idempotencyKey: z.string().uuid(),
  externalPayoutMethod: z.enum(['orange_money', 'mtn_momo', 'card']).optional(),
  pinCode: pinSchema, // consommé par requireTransactionPin
});

const retryBulkPayoutSchema = z.object({
  externalPayoutMethod: z.enum(['orange_money', 'mtn_momo', 'card']).optional(),
  // Absent = comportement historique (tous les échecs sont relancés).
  // Fourni = ne relance que ces lignes précises (sélection dans le tableau de bord).
  itemIds: z.array(z.string().uuid()).min(1).optional(),
  pinCode: pinSchema, // consommé par requireTransactionPin
});

module.exports = { createBulkPayoutSchema, retryBulkPayoutSchema };

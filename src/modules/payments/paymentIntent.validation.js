const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const createIntentSchema = z.object({
  payerPhone: z.string().regex(/^\+224\d{8,9}$/),
  amount: z.number().positive(),
  reference: z.string().max(200).optional(),
  idempotencyKey: z.string().uuid(),
});

const approveIntentSchema = z.object({
  pinCode: pinSchema, // consommé par requireTransactionPin
});

const testResolveIntentSchema = z.object({
  outcome: z.enum(['APPROVED', 'REJECTED']),
});

// Appelé par le PARTENAIRE (sa clé API), jamais directement par le client
// final : c'est le backend du partenaire qui relaie le choix fait dans
// SON propre checkout. Pas d'otpCode (aucune session FlexPay à protéger
// côté client final), un numéro de téléphone à la place.
const collectIntentExternalSchema = z.object({
  phone: z.string().regex(/^\+224\d{8,9}$/, 'Numéro invalide (format +224XXXXXXXX)'),
  provider: z.enum(['orange_money', 'mtn_momo', 'card']),
});

module.exports = { createIntentSchema, approveIntentSchema, testResolveIntentSchema, collectIntentExternalSchema };

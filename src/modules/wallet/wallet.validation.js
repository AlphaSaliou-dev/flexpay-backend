const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const idempotencyKeySchema = z.string().uuid('idempotencyKey doit être un UUID généré côté client');

const depositSchema = z.object({
  amount: z.number().positive(),
  idempotencyKey: idempotencyKeySchema,
  provider: z.enum(['orange_money', 'mtn_momo', 'bank']),
});

const withdrawSchema = z.object({
  amount: z.number().positive(),
  idempotencyKey: idempotencyKeySchema,
  provider: z.enum(['orange_money', 'mtn_momo', 'bank']),
  pinCode: pinSchema, // consommé par requireTransactionPin
});

const transferSchema = z.object({
  toPhone: z.string().regex(/^\+224\d{8,9}$/),
  amount: z.number().positive(),
  idempotencyKey: idempotencyKeySchema,
  pinCode: pinSchema, // consommé par requireTransactionPin
  // Choisi par l'expéditeur UNIQUEMENT si le destinataire n'a pas de
  // compte FlexPay actif (repli vers l'opérateur mobile money, même
  // principe que bulkPayout) - absent/ignoré si le destinataire a bien
  // FlexPay, voir wallet.service.js.
  externalPayoutMethod: z.enum(['orange_money', 'mtn_momo', 'card']).optional(),
});

module.exports = { depositSchema, withdrawSchema, transferSchema };

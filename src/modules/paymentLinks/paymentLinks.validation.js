const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

// Montant obligatoire : un lien sans montant n'a pas d'utilité réelle pour
// l'institution (impossible à rapprocher d'une vente précise). L'expiration
// n'est pas demandée ici - elle est entièrement gérée par le serveur
// (voir LINK_LIFETIME_MS dans paymentLinks.service.js), jamais choisie par
// le marchand.
const createPaymentLinkSchema = z.object({
  label: z.string().min(2).max(120),
  amount: z.number().positive(),
});

const toggleActiveSchema = z.object({
  active: z.boolean(),
});

const payViaLinkSchema = z.object({
  idempotencyKey: z.string().uuid(),
  customFields: z.record(z.string(), z.string().max(200)).optional(), // ex: { nom_de_leleve: "Mariama Camara" }
  pinCode: pinSchema, // consommé par requireTransactionPin
});

// Paiement invité, sans compte FlexPay : Mobile Money/carte au lieu du
// wallet - pas d'otpCode (aucune session à protéger), un numéro de
// téléphone à la place (celui qui recevra la demande de confirmation,
// mockée ici).
const payViaLinkMobileMoneySchema = z.object({
  phone: z.string().regex(/^\+224\d{8,9}$/, 'Numéro invalide (format +224XXXXXXXX)'),
  provider: z.enum(['orange_money', 'mtn_momo', 'card']),
  idempotencyKey: z.string().uuid(),
  customFields: z.record(z.string(), z.string().max(200)).optional(),
});

module.exports = { createPaymentLinkSchema, toggleActiveSchema, payViaLinkSchema, payViaLinkMobileMoneySchema };

const { z } = require('zod');

const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const totpCodeSchema = z.object({
  pendingToken: z.string().min(1),
  code: z.string().length(6),
});

const reviewSchema = z.object({
  approved: z.boolean(),
  rejectionReason: z.string().max(500).optional(),
});

const createApiClientSchema = z.object({
  name: z.string().min(2).max(100),
  businessUserId: z.string().uuid(),
  environment: z.enum(['LIVE', 'TEST']).default('LIVE'),
  // Optionnels - null/absent = comportement historique (n'expire jamais,
  // aucune restriction d'IP).
  expiresAt: z.coerce.date().optional(),
  allowedIps: z.array(z.string().min(1)).optional(),
});

module.exports = { adminLoginSchema, totpCodeSchema, reviewSchema, createApiClientSchema };

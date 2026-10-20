const { z } = require('zod');

const createPayoutSchema = z.object({
  recipientPhone: z.string().regex(/^\+224\d{8,9}$/),
  amount: z.number().positive(),
  reference: z.string().max(200).optional(),
  idempotencyKey: z.string().uuid(),
  // TEST uniquement - ignoré silencieusement en LIVE (voir apiPayout.service.js).
  forceOutcome: z.enum(['COMPLETED', 'FAILED']).optional(),
});

module.exports = { createPayoutSchema };

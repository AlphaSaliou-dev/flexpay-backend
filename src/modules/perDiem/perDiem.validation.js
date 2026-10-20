const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Heure invalide (format HH:MM)');

const upsertScheduleSchema = z
  .object({
    enabled: z.boolean(),
    groupId: z.string().uuid().nullable().optional(),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('DAILY'),
    timeOfDay: timeOfDaySchema.default('07:00'),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    externalPayoutMethod: z.enum(['orange_money', 'mtn_momo', 'card']).nullable().optional(),
    reference: z.string().max(200).optional(),
  })
  .refine((v) => v.frequency !== 'WEEKLY' || v.dayOfWeek != null, {
    message: 'dayOfWeek requis pour une fréquence hebdomadaire',
    path: ['dayOfWeek'],
  })
  .refine((v) => v.frequency !== 'MONTHLY' || v.dayOfMonth != null, {
    message: 'dayOfMonth requis pour une fréquence mensuelle',
    path: ['dayOfMonth'],
  });

const runNowSchema = z.object({
  pinCode: pinSchema, // consommé par requireTransactionPin
});

module.exports = { upsertScheduleSchema, runNowSchema };

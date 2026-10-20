const { z } = require('zod');

const memberSchema = z.object({
  label: z.string().max(100).optional(),
  phone: z.string().regex(/^\+224\d{8,9}$/),
  defaultAmount: z.number().positive().optional(),
  defaultReference: z.string().max(200).optional(),
});

const groupSchema = z.object({
  name: z.string().min(2).max(100),
  members: z.array(memberSchema).min(1, 'Au moins un membre est requis'),
});

module.exports = { groupSchema };

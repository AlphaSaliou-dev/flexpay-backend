const { z } = require('zod');
const { pinSchema } = require('../auth/auth.validation');

const topUpSchema = z.object({
  amount: z.number().positive(),
  pinCode: pinSchema, // consommé par requireTransactionPin
});

module.exports = { topUpSchema };

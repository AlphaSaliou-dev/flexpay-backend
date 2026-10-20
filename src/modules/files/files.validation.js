const { z } = require('zod');

const PURPOSES = ['KYC_ID_DOCUMENT', 'KYC_SELFIE', 'KYB_LEGAL_REP_ID', 'KYB_BUSINESS_DOCUMENT', 'KYB_UBO_ID_DOCUMENT', 'BUSINESS_RECEIPT_LOGO'];

const uploadQuerySchema = z.object({
  purpose: z.enum(PURPOSES),
});

module.exports = { PURPOSES, uploadQuerySchema };

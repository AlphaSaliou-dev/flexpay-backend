const { z } = require('zod');

const submitContactMessageSchema = z.object({
  fullName: z.string().min(2).max(120),
  contactInfo: z.string().min(5).max(120), // email ou téléphone, au choix de l'expéditeur
  subject: z.string().min(2).max(150),
  message: z.string().min(10).max(2000),
  source: z.enum(['landing', 'app']),
});

module.exports = { submitContactMessageSchema };

const { z } = require('zod');

// Format E.164 pour la Guinée : +224 suivi de 8 ou 9 chiffres
const phoneSchema = z.string().regex(/^\+224\d{8,9}$/, 'Numéro guinéen invalide (format +224XXXXXXXX)');

// Mot de passe : au moins 8 caractères, une majuscule, un chiffre.
// Pas de règle "caractère spécial obligatoire" - ça pousse les gens vers
// des mots de passe prévisibles ("Password1!"). La longueur prime.
const passwordSchema = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
  .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule')
  .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre');

const registerSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
  fullName: z.string().min(2).max(100).optional(),
  declaresCommercialUse: z.boolean().default(false),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'Vous devez accepter les CGU et la Politique de Confidentialité' }),
  }),
});

const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6),
});

const resendOtpSchema = z.object({
  phone: phoneSchema,
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
  otpCode: z.string().length(6), // consommé par requireSensitiveOtp
});

const forgotPasswordSchema = z.object({
  phone: phoneSchema,
});

const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6),
  newPassword: passwordSchema,
});

// Le téléphone reste l'identifiant immuable du compte - seul le nom
// complet (affiché, jamais utilisé pour l'identité/l'authentification)
// est modifiable ici.
const updateProfileSchema = z.object({
  fullName: z.string().min(2).max(100),
});

// Code PIN de transaction : 4 OU 6 chiffres (choix de l'utilisateur à la
// création), jamais autre chose - voir requireTransactionPin.js.
const pinSchema = z.string().regex(/^\d{4}$|^\d{6}$/, 'Le code PIN doit contenir 4 ou 6 chiffres');

// Première définition : aucune preuve supplémentaire (le compte vient
// d'être authentifié, pas encore de PIN à protéger). Changement d'un PIN
// existant : protégé par l'ANCIEN PIN (currentPin), jamais par le mot de
// passe - cohérent avec changePasswordSchema qui redemande l'ancien
// secret du même type, pas un autre. currentPin optionnel ici : le
// service vérifie sa présence seulement si un PIN existe déjà.
const setTransactionPinSchema = z.object({
  currentPin: pinSchema.optional(),
  pin: pinSchema,
});

module.exports = {
  phoneSchema,
  passwordSchema,
  registerSchema,
  verifyOtpSchema,
  resendOtpSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  pinSchema,
  setTransactionPinSchema,
};

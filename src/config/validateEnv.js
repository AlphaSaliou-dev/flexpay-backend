const { z } = require('zod');

// Valeurs par défaut du .env.example - si elles se retrouvent encore en
// production, c'est qu'un secret n'a jamais été changé. Ça arrive plus
// souvent qu'on ne le pense lors d'un déploiement précipité.
const PLACEHOLDER_SECRETS = [
  'change_me_in_production',
  'change_me_too_in_production',
  'change_me_admin_secret_in_production',
];

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis'),
  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET est requis'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET est requis'),
  JWT_ADMIN_SECRET: z.string().min(1, 'JWT_ADMIN_SECRET est requis'),
});

class EnvValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

// Ne fait jamais process.exit() elle-même - lève une erreur et laisse
// l'appelant (server.js) décider de la réaction. C'est ce qui rend cette
// fonction testable sans faire planter le process de test lui-même.
function validateEnv(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new EnvValidationError(
      'Variables d\'environnement manquantes ou invalides',
      result.error.flatten().fieldErrors
    );
  }

  if (env.NODE_ENV === 'production') {
    const secrets = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.JWT_ADMIN_SECRET];
    const stillUsingPlaceholder = secrets.some((s) => PLACEHOLDER_SECRETS.includes(s));
    if (stillUsingPlaceholder) {
      throw new EnvValidationError(
        'Un ou plusieurs secrets JWT utilisent encore la valeur par défaut du .env.example - à changer avant la production',
        {}
      );
    }
  }

  return true;
}

module.exports = { validateEnv, EnvValidationError, PLACEHOLDER_SECRETS };

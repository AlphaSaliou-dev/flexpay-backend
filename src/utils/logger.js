const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// En développement : sortie lisible par un humain (pino-pretty si
// installé). En production/test : JSON brut, fait pour être ingéré par
// un système de collecte de logs (CloudWatch, Datadog, etc.), pas pour
// être lu directement dans un terminal.
const logger = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  transport: !isProduction && !isTest
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
  redact: {
    // Jamais un mot de passe, un token ou une clé API dans les logs,
    // même par accident via un objet passé tel quel en contexte de log.
    paths: ['password', 'newPassword', 'currentPassword', 'passwordHash', 'otpCode', 'apiKey', 'token', 'refreshToken', 'accessToken', '*.password', '*.apiKey'],
    censor: '[REDACTED]',
  },
});

// --- Suivi d'erreurs (Sentry) - optionnel, activé seulement si SENTRY_DSN
// est configuré. Sans ça, captureException ne fait rien : jamais une
// dépendance dure à un compte externe que l'équipe n'a pas encore créé.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  Sentry = require('@sentry/node');
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
  logger.info('Sentry activé pour le suivi d\'erreurs');
}

// Point d'entrée unique pour signaler une erreur inattendue - remplace
// tous les `console.error('[module] unexpected error:', err)` dispersés
// dans les contrôleurs. Log structuré systématique + envoi à Sentry si
// configuré, jamais l'un sans l'autre.
function logError(context, err, extra = {}) {
  logger.error({ err, context, ...extra }, `Erreur inattendue : ${context}`);
  if (Sentry) {
    Sentry.captureException(err, { tags: { context }, extra });
  }
}

module.exports = { logger, logError, Sentry };

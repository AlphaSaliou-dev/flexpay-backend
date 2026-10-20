module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  clearMocks: true,
  // otplib (2FA) dépend de @scure/base, publié en ESM pur - Jest ne peut
  // pas le require() sans transformation. Par défaut, tout node_modules
  // est exclu de la transformation Babel ; on retire spécifiquement ces
  // deux paquets de l'exclusion, sans transformer tout le reste (plus
  // lent, inutile pour du code déjà en CommonJS).
  transformIgnorePatterns: ['node_modules/(?!(otplib|@otplib|@scure|@noble)/)'],
  // Le module de base de données (config/db.js) est systématiquement mocké
  // dans les tests unitaires et de service - jamais de vraie connexion
  // PostgreSQL dans cette suite. Les tests d'intégration contre une vraie
  // base (tests/integration/) sont volontairement séparés et ne tournent
  // qu'en CI ou en local, jamais dans ce jeu de tests rapide.
  collectCoverageFrom: ['src/**/*.js', '!src/server.js'],
};

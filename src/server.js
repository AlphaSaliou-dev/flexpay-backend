require('dotenv').config();

const { validateEnv, EnvValidationError } = require('./config/validateEnv');

try {
  validateEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    console.error('❌ Configuration invalide - le serveur ne démarre pas.');
    console.error(err.message);
    if (err.details && Object.keys(err.details).length > 0) {
      console.error(JSON.stringify(err.details, null, 2));
    }
    process.exit(1);
  }
  throw err;
}

const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`FlexPay backend démarré sur le port ${PORT}`);
});

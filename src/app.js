const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils/logger');

const authRoutes = require('./modules/auth/auth.routes');
const kycRoutes = require('./modules/kyc/kyc.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const virtualCardRoutes = require('./modules/virtualCard/virtualCard.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const bulkPayoutRoutes = require('./modules/bulkPayout/bulkPayout.routes');
const perDiemRoutes = require('./modules/perDiem/perDiem.routes');
const filesRoutes = require('./modules/files/files.routes');
const merchantsRoutes = require('./modules/merchants/merchants.routes');
const notificationsRoutes = require('./modules/notifications/notifications.routes');
const paymentLinksRoutes = require('./modules/paymentLinks/paymentLinks.routes');
const contactRoutes = require('./modules/contact/contact.routes');
const smsCommandRoutes = require('./modules/smsCommands/smsCommand.routes');

const app = express();

app.use(helmet());
app.use(cors()); // à restreindre à des origines précises avant la production
app.use(express.json({ limit: '100kb' })); // limite volontairement basse : une fintech n'a pas besoin de gros payloads

// Un identifiant de corrélation unique par requête, propagé dans TOUS les
// logs émis pendant son traitement (y compris ceux des services appelés
// en cascade, via req.log) - permet de retracer le fil complet d'une
// requête dans un océan de logs JSON, ce qu'un simple console.log ne
// permet jamais de faire une fois en production.
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Jamais le corps de la requête dans les logs par défaut - il peut
  // contenir un mot de passe ou un code OTP en clair au moment de l'envoi,
  // même si logger.js les censure déjà en cas de fuite indirecte.
  serializers: { req: (req) => ({ method: req.method, url: req.url, id: req.id }) },
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Documentation API interactive - lue depuis docs/openapi.yaml (un seul
// fichier source, jamais dupliqué). Accessible sans authentification :
// c'est de la documentation publique, comme celle de n'importe quelle API
// destinée à des partenaires externes (Stripe, Flutterwave, etc.).
const openApiSpec = yaml.load(fs.readFileSync(path.join(__dirname, '../docs/openapi.yaml'), 'utf8'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: 'FlexPay API — Documentation',
}));
app.get('/docs.json', (req, res) => res.json(openApiSpec)); // spec brute, pour génération de client (Postman, SDK...)

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/kyc', kycRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/virtual-card', virtualCardRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/bulk-payout', bulkPayoutRoutes);
app.use('/api/v1/per-diem', perDiemRoutes);
app.use('/api/v1/files', filesRoutes);
app.use('/api/v1/merchants', merchantsRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/payment-links', paymentLinksRoutes);
app.use('/api/v1/contact', contactRoutes);
app.use('/api/v1/sms-commands', smsCommandRoutes);

// Handler générique pour toute route non trouvée
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

module.exports = app;

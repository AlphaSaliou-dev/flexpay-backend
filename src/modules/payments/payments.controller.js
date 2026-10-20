const paymentsService = require('./payments.service');
const { logError } = require('../../utils/logger');
const {
  BusinessFieldError,
  getReceiptBranding: getReceiptBrandingService,
  setReceiptBranding: setReceiptBrandingService,
} = require('./businessPaymentFields.service');
const receiptService = require('./receipt.service');
const { signReceiptDownloadToken, verifyReceiptDownloadToken } = require('./receiptToken.util');
const { verifyAccessToken } = require('../../utils/jwt');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof paymentsService.PaymentError || err instanceof BusinessFieldError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('payments', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

async function payMerchant(req, res) {
  try {
    const { businessUserId, amount, idempotencyKey, reference, customFields } = req.body;

    const result = await paymentsService.payBusiness({
      payerUserId: req.user.id,
      businessUserId,
      amount,
      idempotencyKey,
      metadata: { reference, channel: 'in_app' },
      customFields,
    });

    res.status(200).json({
      status: 'COMPLETED',
      amountPaid: Number(amount),
      feeCharged: result.feeAmount,
      transactionId: result.payment.id,
    });
  } catch (err) {
    if (err instanceof paymentsService.PaymentError || err instanceof BusinessFieldError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('payments', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

const getMyApiClientStatus = handle((req) => paymentsService.getMyApiClientStatus(req.user.id));
const requestTestApiKey = handle((req) => paymentsService.requestTestApiKey(req.user.id));
const regenerateApiKey = handle((req) => paymentsService.regenerateApiKey(req.user.id, req.params.id));
const setWebhookUrl = handle((req) => paymentsService.setWebhookUrl(req.user.id, req.params.id, req.body.webhookUrl));
const setEnabledExternalMethods = handle((req) =>
  paymentsService.setEnabledExternalMethods(req.user.id, req.params.id, req.body.enabledExternalMethods)
);
const regenerateWebhookSecret = handle((req) => paymentsService.regenerateWebhookSecret(req.user.id, req.params.id));
const listReceivedPayments = handle((req) => paymentsService.listReceivedPayments(req.user.id, req.query));
const getReceivedPaymentsSummary = handle((req) =>
  paymentsService.getReceivedPaymentsSummary(req.user.id, { days: req.query.days ? Number(req.query.days) : undefined })
);
const getReceiptBranding = handle((req) => getReceiptBrandingService(req.user.id));
const setReceiptBranding = handle((req) => setReceiptBrandingService(req.user.id, req.body));

// Génère un lien de téléchargement du reçu à courte durée de vie -
// l'accès est vérifié ICI (avant d'émettre le token), pas seulement à
// l'ouverture du lien.
async function getReceiptDownloadLink(req, res) {
  try {
    await receiptService.loadTransactionForReceipt(req.params.transactionId, req.user.id);
    const token = signReceiptDownloadToken(req.user.id, req.params.transactionId);
    res.status(200).json({ token });
  } catch (err) {
    if (err instanceof receiptService.ReceiptError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('payments', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// Accepte TROIS modes d'accès pour cette seule route : le header Bearer
// habituel (usage direct authentifié), un token de téléchargement à
// portée limitée en paramètre d'URL (ouverture directe dans un
// navigateur/lecteur PDF externe, qui ne peut pas porter de header
// personnalisé), ou AUCUN des deux - auquel cas userId reste null et
// generateReceiptPdf n'autorisera l'accès que si la transaction est
// elle-même un paiement invité (sans compte FlexPay, voir
// payBusinessGuest) : jamais un paiement avec un vrai payeur.
async function downloadReceipt(req, res) {
  try {
    let userId = null;

    if (req.query.token) {
      const payload = verifyReceiptDownloadToken(String(req.query.token));
      if (payload.transactionId !== req.params.transactionId) {
        return res.status(403).json({ error: 'Token invalide pour ce reçu' });
      }
      userId = payload.sub;
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      userId = verifyAccessToken(req.headers.authorization.slice('Bearer '.length)).sub;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recu-${req.params.transactionId}.pdf"`);
    await receiptService.generateReceiptPdf(req.params.transactionId, userId, res);
  } catch (err) {
    if (err instanceof receiptService.ReceiptError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }
    logError('payments', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
  }
}

// Page publique de vérification - accessible à quiconque scanne le QR du
// reçu, sans authentification. Rendu HTML volontairement minimal et
// auto-suffisant (pas de dépendance à un frontend séparé) pour qu'un
// simple scan depuis n'importe quel téléphone affiche directement le
// résultat dans le navigateur, sans rien à installer.
async function verifyReceipt(req, res) {
  try {
    const data = await receiptService.getPublicVerificationData(req.params.transactionId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vérification de reçu FlexPay</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #F6F8FB; margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #FFF; border-radius: 16px; padding: 32px; max-width: 380px; width: 100%; box-shadow: 0 4px 20px rgba(10,37,64,0.08); text-align: center; }
  .check { width: 56px; height: 56px; border-radius: 50%; background: #E9F7EF; color: #16A34A; font-size: 28px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
  h1 { font-size: 18px; color: #16A34A; margin: 0 0 20px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #E4E9F0; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .label { color: #8A94A6; }
  .value { color: #101828; font-weight: 600; }
  .brand { margin-top: 20px; font-size: 12px; color: #8A94A6; }
</style></head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Reçu authentique</h1>
    <div class="row"><span class="label">Institution</span><span class="value">${data.businessName || '—'}</span></div>
    <div class="row"><span class="label">Montant</span><span class="value">${data.amount.toLocaleString('fr-FR')} ${data.currency}</span></div>
    <div class="row"><span class="label">Date</span><span class="value">${new Date(data.date).toLocaleDateString('fr-FR')}</span></div>
    <div class="row"><span class="label">N° de reçu</span><span class="value" style="font-size:11px;">${data.transactionId}</span></div>
    <div class="brand">Vérifié par FlexPay</div>
  </div>
</body></html>`);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(`<!DOCTYPE html><html lang="fr"><body style="font-family:sans-serif; text-align:center; padding:60px 20px; color:#DC2626;"><h2>Reçu introuvable</h2><p>Ce reçu n'existe pas ou n'est plus valide.</p></body></html>`);
  }
}

module.exports = {
  payMerchant,
  getMyApiClientStatus,
  requestTestApiKey,
  regenerateApiKey,
  setWebhookUrl,
  setEnabledExternalMethods,
  regenerateWebhookSecret,
  listReceivedPayments,
  getReceivedPaymentsSummary,
  getReceiptBranding,
  setReceiptBranding,
  getReceiptDownloadLink,
  downloadReceipt,
  verifyReceipt,
};

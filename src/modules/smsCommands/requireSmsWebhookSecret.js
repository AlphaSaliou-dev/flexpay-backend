// Authentifie l'appel entrant du fournisseur SMS (webhook "SMS reçu"),
// pas un utilisateur final - sans ça, n'importe qui pourrait POSTer de
// faux SMS entrants et usurper l'identité d'un numéro. Secret partagé
// configuré chez le fournisseur (Nimba SMS) ET ici, jamais dans l'URL
// (en-tête seulement, pour ne jamais finir dans un log d'accès).
function requireSmsWebhookSecret(req, res, next) {
  const expected = process.env.SMS_INBOUND_WEBHOOK_SECRET || 'dev-sms-webhook-secret';
  const provided = req.headers['x-sms-webhook-secret'];

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Secret de webhook SMS invalide ou manquant' });
  }

  next();
}

module.exports = { requireSmsWebhookSecret };

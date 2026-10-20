const smsCommandService = require('./smsCommand.service');
const { logError } = require('../../utils/logger');

// Toujours 200 vers le fournisseur SMS, même en cas d'erreur inattendue :
// un code d'erreur HTTP le ferait retenter l'envoi du webhook (même SMS
// traité plusieurs fois), alors que handleIncomingSms a déjà répondu à
// l'utilisateur par un SMS séparé pour toute erreur attendue. Les erreurs
// vraiment inattendues sont journalisées (logError) avant ce 200.
async function inbound(req, res) {
  const { from, text, messageId } = req.body || {};

  if (!from || !text) {
    return res.status(400).json({ error: 'from et text requis' });
  }

  try {
    await smsCommandService.handleIncomingSms({ from, text, messageId });
  } catch (err) {
    logError('smsCommand.inbound', err);
  }

  res.status(200).json({ received: true });
}

module.exports = { inbound };

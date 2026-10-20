const contactService = require('./contact.service');
const { logError } = require('../../utils/logger');

async function submit(req, res) {
  try {
    const result = await contactService.submitContactMessage(req);
    res.status(200).json({ received: true, id: result.id, createdAt: result.createdAt });
  } catch (err) {
    logError('contact', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { submit };

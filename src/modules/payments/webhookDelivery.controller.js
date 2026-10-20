const webhookService = require('./webhook.service');
const { logError } = require('../../utils/logger');

const list = async (req, res) => {
  try {
    const result = await webhookService.listDeliveriesForApiClient(req.apiClient, req.query);
    res.status(200).json(result);
  } catch (err) {
    logError('webhook-delivery', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { list };

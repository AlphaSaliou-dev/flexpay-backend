const cardService = require('./virtualCard.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof cardService.VirtualCardError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('virtual-card', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const issueCard = handle((req) => cardService.issueCard(req.user.id));
const getMyCard = handle((req) => cardService.getMyCard(req.user.id));
const topUp = handle((req) => cardService.topUp(req.user.id, req.body.amount));
const freeze = handle((req) => cardService.freezeCard(req.user.id));
const unfreeze = handle((req) => cardService.unfreezeCard(req.user.id));
const reveal = handle((req) => cardService.revealDetails(req.user.id));

module.exports = { issueCard, getMyCard, topUp, freeze, unfreeze, reveal };

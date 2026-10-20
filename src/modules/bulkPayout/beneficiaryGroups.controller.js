const groupsService = require('./beneficiaryGroups.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof groupsService.BeneficiaryGroupError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('beneficiary-groups', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const create = handle((req) => groupsService.createGroup(req.user.id, req.body));
const list = handle((req) => groupsService.listGroups(req.user.id));
const getOne = handle((req) => groupsService.getGroup(req.user.id, req.params.id));
const update = handle((req) => groupsService.updateGroup(req.user.id, req.params.id, req.body));
const remove = handle(async (req) => {
  await groupsService.deleteGroup(req.user.id, req.params.id);
  return { deleted: true };
});

module.exports = { create, list, getOne, update, remove };

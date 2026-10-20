const fieldsService = require('./businessPaymentFields.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof fieldsService.BusinessFieldError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('business-fields', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const list = handle((req) => fieldsService.listFieldsForOwner(req.user.id));
const create = handle((req) => fieldsService.createField(req.user.id, req.body));
const update = handle((req) => fieldsService.updateField(req.user.id, req.params.id, req.body));
const remove = handle(async (req) => {
  await fieldsService.deleteField(req.user.id, req.params.id);
  return { deleted: true };
});

module.exports = { list, create, update, remove };

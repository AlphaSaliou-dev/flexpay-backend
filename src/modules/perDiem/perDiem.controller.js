const perDiemService = require('./perDiem.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof perDiemService.PerDiemError || err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('per-diem', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const getSchedule = handle((req) => perDiemService.getSchedule(req.user.id));
const upsertSchedule = handle((req) => perDiemService.upsertSchedule(req.user.id, req.body));
const runNow = handle((req) => perDiemService.runNow(req.user.id));

module.exports = { getSchedule, upsertSchedule, runNow };

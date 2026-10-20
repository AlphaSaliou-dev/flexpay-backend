const express = require('express');
const { validate } = require('../../middlewares/validate');
const { requireAuth } = require('../../middlewares/requireAuth');
const { requireTransactionPin } = require('../auth/requireTransactionPin');
const { upsertScheduleSchema, runNowSchema } = require('./perDiem.validation');
const controller = require('./perDiem.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', controller.getSchedule);
router.put('/', validate(upsertScheduleSchema), controller.upsertSchedule);
router.post('/run-now', validate(runNowSchema), requireTransactionPin, controller.runNow);

module.exports = router;

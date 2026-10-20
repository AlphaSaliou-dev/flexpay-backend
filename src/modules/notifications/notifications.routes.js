const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middlewares/requireAuth');
const { validate } = require('../../middlewares/validate');
const notificationService = require('./notification.service');
const { logError } = require('../../utils/logger');

const router = express.Router();
router.use(requireAuth);

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof notificationService.NotificationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('notifications', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const registerTokenSchema = z.object({
  token: z.string().min(1),
});

const preferencesSchema = z.object({
  notifyOnTransactions: z.boolean().optional(),
  notifyOnPaymentRequests: z.boolean().optional(),
});

router.put('/push-token', validate(registerTokenSchema), async (req, res) => {
  try {
    await notificationService.registerPushToken(req.user.id, req.body.token);
    res.status(200).json({ registered: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', handle((req) => notificationService.listNotifications(req.user.id)));
router.post('/:id/read', handle((req) => notificationService.markAsRead(req.user.id, req.params.id)));
router.post('/read-all', handle((req) => notificationService.markAllAsRead(req.user.id)));

router.get('/preferences', handle((req) => notificationService.getPreferences(req.user.id)));
router.put(
  '/preferences',
  validate(preferencesSchema),
  handle((req) => notificationService.updatePreferences(req.user.id, req.body))
);

module.exports = router;

const express = require('express');
const { validate } = require('../../middlewares/validate');
const { contactLimiter } = require('../../middlewares/rateLimiter');
const { submitContactMessageSchema } = require('./contact.validation');
const controller = require('./contact.controller');

const router = express.Router();

// Public - pas de requireAuth : voir contact.service pour le rattachement
// optionnel à un compte quand un jeton valide est présent.
router.post('/', contactLimiter, validate(submitContactMessageSchema), controller.submit);

module.exports = router;

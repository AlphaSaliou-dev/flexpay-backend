const express = require('express');
const { requireAuth } = require('../../middlewares/requireAuth');
const { searchMerchants, listMerchants } = require('./merchants.service');
const { listFieldsForPayer } = require('../payments/businessPaymentFields.service');

const router = express.Router();

router.use(requireAuth);

// Catalogue parcourable, sans terme de recherche requis - pour l'écran
// "Catalogue des institutions" (on ne trouve pas ce dont on ignore
// l'orthographe exacte via /search seul). Filtre optionnel ?category=.
router.get('/', async (req, res) => {
  const category = req.query.category ? String(req.query.category).trim() : undefined;
  const results = await listMerchants({ category });
  res.json(results);
});

router.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Requête de recherche trop courte (2 caractères min.)' });
  }
  const results = await searchMerchants(query);
  res.json(results);
});

// Champs personnalisés que ce marchand demande à ses payeurs (ex: "Nom
// de l'élève" pour une école) - consultation publique, avant paiement.
router.get('/:businessUserId/payment-fields', async (req, res) => {
  const fields = await listFieldsForPayer(req.params.businessUserId);
  res.json(fields);
});

module.exports = router;

const prisma = require('../../config/db');
const { hashApiKey } = require('./apiKey.util');

// Authentifie une requête serveur-à-serveur d'un partenaire (ex:
// MarketConnect) via l'en-tête `x-api-key`. Distinct de requireAuth :
// aucun utilisateur final n'est connecté ici, c'est le backend du
// partenaire qui appelle FlexPay en son propre nom.
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({ error: 'Clé API manquante (en-tête x-api-key)' });
  }

  const apiClient = await prisma.apiClient.findUnique({
    where: { apiKeyHash: hashApiKey(key) },
  });

  if (!apiClient || apiClient.status !== 'ACTIVE') {
    return res.status(401).json({ error: 'Clé API invalide ou révoquée' });
  }

  if (apiClient.expiresAt && apiClient.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Clé API expirée' });
  }

  if (apiClient.allowedIps.length > 0 && !apiClient.allowedIps.includes(req.ip)) {
    return res.status(403).json({ error: 'Adresse IP non autorisée pour cette clé API' });
  }

  // Jamais attendu (pas de "await") : mettre à jour lastUsedAt ne doit
  // jamais ajouter de latence au chemin critique d'un appel partenaire,
  // et un échec de cette écriture ne doit jamais faire échouer la requête.
  prisma.apiClient
    .update({ where: { id: apiClient.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  req.apiClient = apiClient;
  next();
}

module.exports = { requireApiKey };

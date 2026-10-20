const crypto = require('crypto');

// Format des clés : fp_live_<32 caractères aléatoires> (ou fp_test_ en sandbox).
// Seul le hash est stocké en base ; le préfixe (ex: "fp_live_8f2a") reste
// visible pour que le partenaire identifie sa clé dans son dashboard sans
// qu'on ait besoin de la lui remontrer en entier.
function generateApiKey(env = 'live') {
  const raw = `fp_${env}_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { generateApiKey, hashApiKey };

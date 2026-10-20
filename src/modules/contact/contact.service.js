const prisma = require('../../config/db');
const { verifyAccessToken } = require('../../utils/jwt');

// Entièrement public (site vitrine sans compte, app sans jeton obligatoire) -
// un visiteur ne doit jamais être bloqué de contacter le support. Si un
// jeton valide est présent, le message est relié au compte pour aider le
// support à retrouver l'historique ; un jeton absent, invalide ou expiré
// laisse simplement userId à null plutôt que de rejeter l'envoi.
async function submitContactMessage(req) {
  let userId = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice('Bearer '.length));
      userId = payload.sub;
    } catch (err) {
      // volontairement silencieux - voir commentaire ci-dessus
    }
  }

  const { fullName, contactInfo, subject, message, source } = req.body;

  return prisma.contactMessage.create({
    data: { userId, fullName, contactInfo, subject, message, source },
    select: { id: true, createdAt: true },
  });
}

module.exports = { submitContactMessage };

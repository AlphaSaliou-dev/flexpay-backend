const { distance } = require('fastest-levenshtein');
const prisma = require('../../config/db');

// En dessous de ce score de similarité (0 = identique, 1 = totalement
// différent), on considère qu'il y a une correspondance à faire vérifier
// par un humain. Volontairement généreux (beaucoup de faux positifs
// possibles - deux noms différents mais proches phonétiquement) : mieux
// vaut trop de vérifications manuelles qu'un vrai résultat manqué.
const MATCH_THRESHOLD = 0.25;

function normalize(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(a, b) {
  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA || !normB) return 1;
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 0;
  return distance(normA, normB) / maxLen;
}

// Compare un nom donné à toute la liste de vigilance (nom complet + tous
// les alias) et retourne les correspondances sous le seuil, triées de la
// plus proche à la moins proche. Ne bloque jamais rien tout seul - le
// résultat est stocké pour qu'un admin le voie pendant la revue KYC/KYB.
async function screenName(name) {
  if (!name || !name.trim()) {
    return { hit: false, matches: [] };
  }

  const entities = await prisma.sanctionedEntity.findMany();
  const matches = [];

  for (const entity of entities) {
    const candidates = [entity.fullName, ...(entity.aliases || [])];
    let bestScore = 1;
    let bestCandidate = null;

    for (const candidate of candidates) {
      const score = similarityScore(name, candidate);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestScore <= MATCH_THRESHOLD) {
      matches.push({
        entityId: entity.id,
        matchedName: entity.fullName,
        matchedAlias: bestCandidate !== entity.fullName ? bestCandidate : null,
        type: entity.type,
        source: entity.source,
        score: Number(bestScore.toFixed(3)),
      });
    }
  }

  matches.sort((a, b) => a.score - b.score);

  return { hit: matches.length > 0, matches };
}

// Filtre plusieurs noms d'un coup (ex: nom de l'entreprise + représentant
// légal pour un KYB) et fusionne le résultat.
async function screenNames(names) {
  const results = await Promise.all(names.filter(Boolean).map((n) => screenName(n)));
  const matches = results.flatMap((r) => r.matches);
  return { hit: matches.length > 0, matches };
}

module.exports = { screenName, screenNames, similarityScore, normalize, MATCH_THRESHOLD };

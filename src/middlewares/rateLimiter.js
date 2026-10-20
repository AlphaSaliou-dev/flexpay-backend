const rateLimit = require('express-rate-limit');

// Désactivé pendant les tests automatisés : sinon l'état du compteur
// (en mémoire, partagé entre requêtes) rendrait les tests dépendants de
// leur ordre d'exécution - un test précédent ferait échouer le suivant
// sans rapport avec ce qu'il vérifie. Le comportement du limiteur
// lui-même reste testé séparément (voir tests/unit/rateLimiter.test.js).
const testSkip = () => process.env.NODE_ENV === 'test';

// Limite stricte sur la connexion : freine les attaques par force brute
// sur le mot de passe, indépendamment du verrouillage de compte applicatif.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Limite encore plus stricte sur la demande d'OTP : évite le spam SMS
// (coût financier direct) et les attaques par déni de service via SMS.
const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Trop de demandes de code. Réessayez dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Limite sur l'API B2B partenaire - volontairement clée sur la CLÉ API
// elle-même (req.apiClient.id), jamais sur l'adresse IP : un partenaire
// fait typiquement tous ses appels depuis un même serveur, donc une
// limite par IP pénaliserait injustement TOUT son trafic légitime en une
// seule fois. Chaque partenaire a ainsi son propre quota indépendant.
// Ce middleware doit toujours être monté APRÈS requireApiKey, qui est
// seul à renseigner req.apiClient.
//
// Plafond plus généreux en TEST (développeur qui itère rapidement en
// debug) qu'en LIVE (protège l'infrastructure de mouvement d'argent réel).
const apiPartnerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (req.apiClient?.environment === 'TEST' ? 400 : 200),
  keyGenerator: (req) => req.apiClient?.id || req.ip, // repli IP seulement si apiClient absent (ne devrait jamais arriver après requireApiKey)
  message: { error: 'Trop de requêtes pour cette clé API. Réessayez dans quelques instants.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Limite la recherche de destinataire par numéro : c'est une primitive
// d'énumération de comptes (existe / n'existe pas) qui n'a jamais besoin
// d'être appelée plus de quelques fois par minute dans un usage normal
// (composer un numéro puis corriger une faute de frappe). Clée sur
// l'utilisateur connecté plutôt que l'IP, car requireAuth s'exécute avant.
const recipientLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop de recherches. Réessayez dans quelques instants.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Paiement de lien par Mobile Money : entièrement public (pas de compte,
// pas d'OTP - voir paymentLinks.service.payViaLinkMobileMoney), donc la
// seule protection contre l'abus est l'IP. Volontairement strict : ce
// chemin déplace de l'argent vers un wallet marchand à chaque appel réussi.
const mobileMoneyPayLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives de paiement. Réessayez dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Formulaire de contact : entièrement public (site vitrine sans compte,
// ou app sans jeton obligatoire), donc seule l'IP protège contre le spam.
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de messages envoyés. Réessayez dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

// Webhook SMS entrant : appelé par le fournisseur (une seule IP source
// pour TOUS les utilisateurs), donc une limite par IP ne pénalise jamais
// un utilisateur en particulier - c'est un filet de sécurité basique
// contre une passerelle défaillante ou un appel malveillant, pas une
// protection par utilisateur (celle-ci vient de l'OTP par commande).
const smsInboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: testSkip,
});

module.exports = {
  loginLimiter,
  otpRequestLimiter,
  apiPartnerLimiter,
  recipientLookupLimiter,
  mobileMoneyPayLimiter,
  contactLimiter,
  smsInboundLimiter,
};

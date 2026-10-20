const prisma = require('../../config/db');
const { getLimitsForUser } = require('../../config/limits');
const { audit } = require('../auth/auth.service');
const sanctionsScreening = require('../compliance/sanctionsScreening.service');
const faceMatchService = require('./faceMatch.service');
const { notifyUser } = require('../notifications/notification.service');

class KycError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// --- Consultation --------------------------------------------------------

async function getMyKycStatus(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { kycProfile: true, businessProfile: true },
  });

  if (!user) throw new KycError('Utilisateur introuvable', 404);

  const limits = getLimitsForUser(user);

  return {
    accountType: user.accountType,
    tier: user.kycProfile?.tier || 'TIER_0',
    business: user.businessProfile
      ? {
          reviewStatus: user.businessProfile.reviewStatus,
          businessName: user.businessProfile.businessName,
          rejectionReason: user.businessProfile.rejectionReason,
        }
      : null,
    limits,
  };
}

// --- Palier 1 : identité déclarée (aucun document) ------------------------

async function submitTier1(userId, { fullName, dateOfBirth }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new KycError('Utilisateur introuvable', 404);
  if (user.accountType !== 'INDIVIDUAL') {
    throw new KycError('Cette étape ne concerne que les comptes particuliers', 400);
  }

  // Filtrage sanctions/PEP sur le nom déclaré - ne bloque jamais la
  // soumission elle-même, seulement signalé pour la revue admin.
  const screening = await sanctionsScreening.screenName(fullName);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { fullName } }),
    prisma.kycProfile.upsert({
      where: { userId },
      create: { userId, tier: 'TIER_1', dateOfBirth, sanctionsHit: screening.hit, sanctionsDetails: screening.matches },
      update: { tier: 'TIER_1', dateOfBirth, sanctionsHit: screening.hit, sanctionsDetails: screening.matches },
    }),
  ]);

  if (screening.hit) {
    await audit(userId, 'SANCTIONS_SCREENING_HIT', { context: 'KYC_TIER1', matches: screening.matches });
  }

  await audit(userId, 'KYC_TIER1_SUBMITTED');

  return { tier: 'TIER_1' };
}

// --- Palier 2 : pièce d'identité officielle --------------------------------
// Soumission = passage en revue PENDING. Le passage effectif au tier 2
// (et donc l'augmentation des plafonds) n'a lieu qu'après validation
// manuelle - jamais automatique pour un document d'identité.

async function submitTier2(userId, { idDocumentType, idDocumentNumber, idDocumentUrl, selfieUrl }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new KycError('Utilisateur introuvable', 404);
  if (user.accountType !== 'INDIVIDUAL') {
    throw new KycError('Cette étape ne concerne que les comptes particuliers', 400);
  }

  // Comparaison faciale pièce d'identité / selfie - jamais bloquant en
  // soi (voir faceMatch.service.js, toujours INCONCLUSIVE sans
  // fournisseur réel), mais le résultat est stocké pour que l'admin le
  // voie explicitement pendant sa revue plutôt que de comparer les deux
  // photos à l'œil sans indication.
  let faceMatchStatus = 'PENDING';
  let faceMatchScore = null;
  try {
    const result = await faceMatchService.compareIdWithSelfie(idDocumentUrl, selfieUrl);
    faceMatchStatus = result.status;
    faceMatchScore = result.score;
  } catch (err) {
    faceMatchStatus = 'INCONCLUSIVE';
  }

  await prisma.kycProfile.upsert({
    where: { userId },
    create: {
      userId,
      tier: 'TIER_1', // reste en tier 1 tant que la revue n'est pas faite
      idDocumentType,
      idDocumentNumber,
      idDocumentUrl,
      selfieUrl,
      faceMatchStatus,
      faceMatchScore,
      reviewStatus: 'PENDING',
    },
    update: {
      idDocumentType,
      idDocumentNumber,
      idDocumentUrl,
      selfieUrl,
      faceMatchStatus,
      faceMatchScore,
      reviewStatus: 'PENDING',
      rejectionReason: null,
    },
  });

  await audit(userId, 'KYC_TIER2_SUBMITTED', { idDocumentType, faceMatchStatus });

  await notifyUser(userId, {
    type: 'KYC_SUBMITTED',
    title: 'Dossier reçu',
    body: "Votre pièce d'identité a bien été reçue, en attente de revue.",
  });

  return { reviewStatus: 'PENDING', faceMatchStatus };
}

// Validation manuelle (support/back-office) - à appeler uniquement depuis
// une route admin protégée, pas encore construite à ce stade du projet.
async function reviewTier2(userId, reviewerId, { approved, rejectionReason }) {
  const profile = await prisma.kycProfile.findUnique({ where: { userId } });
  if (!profile) throw new KycError('Dossier KYC introuvable', 404);

  await prisma.kycProfile.update({
    where: { userId },
    data: {
      tier: approved ? 'TIER_2' : profile.tier,
      reviewStatus: approved ? 'APPROVED' : 'REJECTED',
      reviewedAt: new Date(),
      reviewedBy: reviewerId,
      rejectionReason: approved ? null : rejectionReason,
    },
  });

  await audit(userId, approved ? 'KYC_TIER2_APPROVED' : 'KYC_TIER2_REJECTED', { reviewerId });

  await notifyUser(
    userId,
    approved
      ? { type: 'KYC_APPROVED', title: 'Identité vérifiée ✓', body: 'Votre pièce d\'identité a été validée. Vos plafonds sont augmentés.' }
      : { type: 'KYC_REJECTED', title: 'Vérification refusée', body: rejectionReason || 'Votre pièce d\'identité a été refusée.' },
    approved
      ? "FlexPay : votre pièce d'identité a été validée, vos plafonds sont augmentés."
      : `FlexPay : votre vérification d'identité a été refusée. Motif : ${rejectionReason}`
  );

  return { approved };
}

// --- KYB : compte Business --------------------------------------------------
// Toujours en attente de revue manuelle - jamais de compte Business actif
// sans validation humaine, vu le volume qu'il va encaisser pour des tiers.

async function submitBusinessKyc(userId, data) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new KycError('Utilisateur introuvable', 404);

  const { ubos, ...businessData } = data;

  if (!ubos || ubos.length === 0) {
    throw new KycError('Au moins un bénéficiaire effectif (UBO) est requis', 400);
  }

  // Filtrage sur tous les noms qui identifient réellement l'entité :
  // l'entreprise, son représentant légal, ET chacun de ses bénéficiaires
  // effectifs - une sanction peut viser n'importe lequel d'entre eux, pas
  // seulement la personne qui signe les documents.
  const screening = await sanctionsScreening.screenNames([
    businessData.businessName,
    businessData.legalRepName,
    ...ubos.map((u) => u.fullName),
  ]);

  // Filtrage individuel par UBO aussi, pour savoir précisément LEQUEL est
  // concerné plutôt qu'un seul flag global sur toute l'entreprise.
  const ubosWithScreening = await Promise.all(
    ubos.map(async (ubo) => {
      const uboScreening = await sanctionsScreening.screenName(ubo.fullName);
      return { ...ubo, sanctionsHit: uboScreening.hit, sanctionsDetails: uboScreening.matches };
    })
  );

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { accountType: 'BUSINESS' } }),
    prisma.businessProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...businessData,
        reviewStatus: 'PENDING',
        sanctionsHit: screening.hit,
        sanctionsDetails: screening.matches,
        ubos: { create: ubosWithScreening },
      },
      update: {
        ...businessData,
        reviewStatus: 'PENDING',
        rejectionReason: null,
        sanctionsHit: screening.hit,
        sanctionsDetails: screening.matches,
        // Une resoumission remplace intégralement la liste des UBO
        // précédente plutôt que de l'accumuler - la nouvelle soumission
        // reflète l'état actuel réel de l'actionnariat, pas un historique.
        ubos: { deleteMany: {}, create: ubosWithScreening },
      },
    }),
  ]);

  await audit(userId, 'KYB_SUBMITTED', { businessName: businessData.businessName, uboCount: ubos.length });
  if (screening.hit) {
    await audit(userId, 'SANCTIONS_SCREENING_HIT', { context: 'KYB', matches: screening.matches });
  }

  await notifyUser(userId, {
    type: 'KYB_SUBMITTED',
    title: 'Dossier Business reçu',
    body: 'Votre dossier Business a bien été reçu, en attente de revue.',
  });

  return { reviewStatus: 'PENDING' };
}

// --- Marchand : palier allégé sans registre légal --------------------------
// Pensé pour un petit commerce sans RCCM/NIF (un restaurant qui vient
// d'ouvrir, un vendeur de marché...) : aucune pièce légale à fournir, aucun
// représentant légal ni bénéficiaire effectif à déclarer - juste un nom
// d'activité. En échange, le compte reste bridé (voir bulkPayout.service.js
// et payments.service.js requestTestApiKey) : ni paiement de masse, ni API
// partenaire, seulement l'encaissement de base et les liens de paiement.
//
// Approuvé automatiquement (pas de file d'attente admin) car l'identité de
// la personne derrière le compte a déjà été vérifiée au KYC particulier
// Tier 2 - il n'y a rien de plus à vérifier qu'un admin pourrait faire
// mieux qu'un algorithme, sauf en cas de correspondance sur la liste de
// vigilance, qui bascule le dossier en revue manuelle comme pour un
// Business classique.
async function submitMerchantKyc(userId, { businessName, category, location }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { kycProfile: true } });
  if (!user) throw new KycError('Utilisateur introuvable', 404);

  if (user.accountType === 'BUSINESS') {
    throw new KycError('Ce compte est déjà un compte Entreprise', 400);
  }
  if (user.kycProfile?.tier !== 'TIER_2') {
    throw new KycError('Votre identité doit être vérifiée (KYC palier 2) avant d\'activer un compte Marchand', 400);
  }

  const screening = await sanctionsScreening.screenNames([businessName, user.fullName]);
  const autoApproved = !screening.hit;

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { accountType: 'MERCHANT' } }),
    prisma.businessProfile.upsert({
      where: { userId },
      create: {
        userId,
        businessName,
        category,
        location,
        reviewStatus: autoApproved ? 'APPROVED' : 'PENDING',
        reviewedAt: autoApproved ? new Date() : null,
        sanctionsHit: screening.hit,
        sanctionsDetails: screening.matches,
      },
      update: {
        businessName,
        category,
        location,
        reviewStatus: autoApproved ? 'APPROVED' : 'PENDING',
        reviewedAt: autoApproved ? new Date() : null,
        rejectionReason: null,
        sanctionsHit: screening.hit,
        sanctionsDetails: screening.matches,
      },
    }),
  ]);

  await audit(userId, 'MERCHANT_ACTIVATED', { businessName, autoApproved });
  if (screening.hit) {
    await audit(userId, 'SANCTIONS_SCREENING_HIT', { context: 'MERCHANT', matches: screening.matches });
  }

  await notifyUser(userId, autoApproved
    ? { type: 'KYB_APPROVED', title: 'Compte Marchand activé ✓', body: 'Vous pouvez dès maintenant recevoir des paiements et créer des liens de paiement.' }
    : { type: 'KYB_SUBMITTED', title: 'Dossier Marchand reçu', body: 'Votre dossier est en cours de revue.' }
  );

  return { reviewStatus: autoApproved ? 'APPROVED' : 'PENDING' };
}

async function reviewBusinessKyc(userId, reviewerId, { approved, rejectionReason }) {
  const profile = await prisma.businessProfile.findUnique({ where: { userId } });
  if (!profile) throw new KycError('Dossier Business introuvable', 404);

  await prisma.businessProfile.update({
    where: { userId },
    data: {
      reviewStatus: approved ? 'APPROVED' : 'REJECTED',
      reviewedAt: new Date(),
      reviewedBy: reviewerId,
      rejectionReason: approved ? null : rejectionReason,
    },
  });

  await audit(userId, approved ? 'KYB_APPROVED' : 'KYB_REJECTED', { reviewerId });

  await notifyUser(
    userId,
    approved
      ? { type: 'KYB_APPROVED', title: 'Compte Business validé ✓', body: 'Votre compte Business est maintenant actif.' }
      : { type: 'KYB_REJECTED', title: 'Compte Business refusé', body: rejectionReason || 'Votre dossier Business a été refusé.' },
    approved
      ? 'FlexPay : votre compte Business a été validé, il est maintenant actif.'
      : `FlexPay : votre dossier Business a été refusé. Motif : ${rejectionReason}`
  );

  return { approved };
}

module.exports = {
  KycError,
  getMyKycStatus,
  submitTier1,
  submitTier2,
  reviewTier2,
  submitBusinessKyc,
  submitMerchantKyc,
  reviewBusinessKyc,
};

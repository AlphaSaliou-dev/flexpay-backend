const prisma = require('../../config/db');
const kycService = require('../kyc/kyc.service');
const { generateApiKey } = require('../payments/apiKey.util');
const { parsePagination, buildPaginatedResult } = require('../../utils/pagination');
const authService = require('../auth/auth.service');
const walletService = require('../wallet/wallet.service');

class AdminError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// --- KYC (particuliers, palier 2) -------------------------------------------

async function listPendingKyc(query = {}) {
  const { page, pageSize, skip, take } = parsePagination(query);

  const [items, total] = await Promise.all([
    prisma.kycProfile.findMany({
      where: { reviewStatus: 'PENDING' },
      include: { user: { select: { id: true, phone: true, fullName: true } } },
      orderBy: { updatedAt: 'asc' }, // les plus anciens dossiers en attente d'abord
      skip,
      take,
    }),
    prisma.kycProfile.count({ where: { reviewStatus: 'PENDING' } }),
  ]);

  return buildPaginatedResult(items, total, page, pageSize);
}

async function reviewKyc(adminId, userId, { approved, rejectionReason }) {
  if (!approved && !rejectionReason) {
    throw new AdminError('Un motif de rejet est requis', 400);
  }
  return kycService.reviewTier2(userId, adminId, { approved, rejectionReason });
}

// --- KYB (comptes Business) --------------------------------------------------

async function listPendingKyb(query = {}) {
  const { page, pageSize, skip, take } = parsePagination(query);

  const [items, total] = await Promise.all([
    prisma.businessProfile.findMany({
      where: { reviewStatus: 'PENDING' },
      include: { user: { select: { id: true, phone: true, accountType: true } }, ubos: true },
      orderBy: { updatedAt: 'asc' },
      skip,
      take,
    }),
    prisma.businessProfile.count({ where: { reviewStatus: 'PENDING' } }),
  ]);

  return buildPaginatedResult(items, total, page, pageSize);
}

async function reviewKyb(adminId, userId, { approved, rejectionReason }) {
  if (!approved && !rejectionReason) {
    throw new AdminError('Un motif de rejet est requis', 400);
  }
  return kycService.reviewBusinessKyc(userId, adminId, { approved, rejectionReason });
}

// --- Partenaires API (ex: MarketConnect) ------------------------------------
// Réservé SUPERADMIN (voir routes) - créer une clé API donne à un tiers un
// vrai pouvoir de mouvement d'argent, même encadré par le flux d'approbation.

async function createApiClient({ name, businessUserId, environment, expiresAt, allowedIps }) {
  const business = await prisma.user.findUnique({ where: { id: businessUserId } });
  if (!business || business.accountType !== 'BUSINESS') {
    throw new AdminError("Ce compte n'est pas un compte Business valide", 400);
  }

  const businessProfile = await prisma.businessProfile.findUnique({ where: { userId: businessUserId } });
  if (businessProfile?.reviewStatus !== 'APPROVED') {
    throw new AdminError("Le compte Business doit être validé (KYB) avant de recevoir une clé API", 403);
  }

  const env = environment === 'TEST' ? 'TEST' : 'LIVE';
  const { raw, hash, prefix } = generateApiKey(env.toLowerCase());

  const apiClient = await prisma.apiClient.create({
    data: {
      name,
      businessUserId,
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      environment: env,
      expiresAt: expiresAt ?? null,
      allowedIps: allowedIps ?? [],
    },
  });

  // La clé brute n'est renvoyée qu'ici, une seule fois - jamais récupérable ensuite.
  return { apiClient, apiKey: raw };
}

async function listApiClients() {
  return prisma.apiClient.findMany({
    select: {
      id: true, name: true, apiKeyPrefix: true, environment: true, status: true, createdAt: true, businessUserId: true,
      expiresAt: true, allowedIps: true, lastUsedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function revokeApiClient(id) {
  return prisma.apiClient.update({
    where: { id },
    data: { status: 'SUSPENDED', revokedAt: new Date() },
  });
}

// --- Détection "fan-in" : comptes Particulier qui reçoivent d'un nombre ---
// --- suspect d'expéditeurs distincts (signal d'activité commerciale ------
// --- déguisée en usage personnel) -----------------------------------------
//
// Seuil volontairement généreux (20 expéditeurs distincts / 30 jours) pour
// limiter les faux positifs (cagnotte, tontine, remboursement de groupe).
// Ne bloque jamais automatiquement - alimente uniquement une file de revue
// manuelle côté admin.
async function listSuspiciousFanIn({ thresholdDistinctSenders = 20, windowDays = 30 } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT
      w."userId" AS "userId",
      u.phone AS phone,
      u."fullName" AS "fullName",
      COUNT(DISTINCT debit."walletId")::int AS "distinctSenders",
      COUNT(credit.id)::int AS "totalReceived"
    FROM "LedgerEntry" credit
    JOIN "LedgerEntry" debit ON debit."transactionId" = credit."transactionId" AND debit.direction = 'DEBIT'
    JOIN "Wallet" w ON w.id = credit."walletId"
    JOIN "User" u ON u.id = w."userId"
    WHERE credit.direction = 'CREDIT'
      AND w."ownerType" = 'USER'
      AND u."accountType" = 'INDIVIDUAL'
      AND credit."createdAt" >= NOW() - (${windowDays}::text || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" al
        WHERE al."userId" = w."userId"
          AND al.action = 'RISK_ALERT_DISMISSED'
          AND al.metadata->>'alertType' = 'FAN_IN'
          AND al."createdAt" >= NOW() - (${windowDays}::text || ' days')::interval
      )
    GROUP BY w."userId", u.phone, u."fullName"
    HAVING COUNT(DISTINCT debit."walletId") >= ${thresholdDistinctSenders}
    ORDER BY "distinctSenders" DESC
  `;
  return rows;
}

// --- Détection "structuring" : plusieurs paiements de montant identique ---
// --- ou très proche, en rafale, dans un intervalle court -----------------
//
// Signal classique de contournement volontaire des plafonds : plutôt
// qu'une seule grosse transaction (qui déclencherait le plafond par
// transaction), on fractionne en plusieurs paiements similaires. Trois
// occurrences ou plus du même montant en 24h, pour un même wallet, est un
// pattern qu'un usage normal ne produit presque jamais.
async function listStructuringPatterns({ windowHours = 24, minOccurrences = 3 } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT
      w."userId" AS "userId",
      u.phone AS phone,
      u."fullName" AS "fullName",
      le.amount AS amount,
      COUNT(*)::int AS occurrences,
      SUM(le.amount) AS "totalAmount"
    FROM "LedgerEntry" le
    JOIN "Wallet" w ON w.id = le."walletId"
    JOIN "User" u ON u.id = w."userId"
    WHERE le.direction = 'DEBIT'
      AND w."ownerType" = 'USER'
      AND le."createdAt" >= NOW() - (${windowHours}::text || ' hours')::interval
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" al
        WHERE al."userId" = w."userId"
          AND al.action = 'RISK_ALERT_DISMISSED'
          AND al.metadata->>'alertType' = 'STRUCTURING'
          AND al."createdAt" >= NOW() - (${windowHours}::text || ' hours')::interval
      )
    GROUP BY w."userId", u.phone, u."fullName", le.amount
    HAVING COUNT(*) >= ${minOccurrences}
    ORDER BY occurrences DESC
  `;
  return rows.map((r) => ({ ...r, amount: Number(r.amount), totalAmount: Number(r.totalAmount) }));
}

// « Écarter » une alerte : retire l'entrée de la file SANS toucher au
// compte (aucun statut, aucun solde modifié) - seule une trace est ajoutée
// au journal d'audit, ce qui suffit à la filtrer des prochains appels tant
// que la fenêtre de détection (30j fan-in / 24h structuring) n'est pas
// dépassée. Passé ce délai, un pattern qui persiste réapparaît de lui-même.
async function dismissRiskAlert(adminId, { userId, alertType }) {
  if (!['FAN_IN', 'STRUCTURING'].includes(alertType)) {
    throw new AdminError('Type d\'alerte invalide', 400);
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AdminError('Compte introuvable', 404);

  await prisma.auditLog.create({
    data: { userId, action: 'RISK_ALERT_DISMISSED', metadata: { alertType, dismissedBy: adminId } },
  });
  return { dismissed: true };
}

// --- Liste de vigilance (sanctions/PEP) -------------------------------------

async function listWatchlist() {
  return prisma.sanctionedEntity.findMany({ orderBy: { createdAt: 'desc' } });
}

async function addToWatchlist({ fullName, aliases, type, source }) {
  if (!fullName || !fullName.trim()) {
    throw new AdminError('Le nom complet est requis', 400);
  }
  return prisma.sanctionedEntity.create({
    data: { fullName: fullName.trim(), aliases: aliases || [], type, source: source || 'Ajout manuel' },
  });
}

async function removeFromWatchlist(id) {
  return prisma.sanctionedEntity.delete({ where: { id } });
}

// --- Journal d'audit ---------------------------------------------------------

async function listAuditLog(query = {}) {
  const { page, pageSize, skip, take } = parsePagination(query);
  const where = {};
  if (query.userId) where.userId = query.userId;
  if (query.action) where.action = query.action;

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.auditLog.count({ where }),
  ]);

  return buildPaginatedResult(items, total, page, pageSize);
}

// --- Recherche et fiche utilisateur (actions SUPPORT) -----------------------
// Lecture seule - aucune de ces fonctions ne modifie l'argent ou le statut
// KYC d'un compte. C'est précisément ce qui les rend accessibles au rôle
// SUPPORT sans risque financier.

async function searchUsers(query) {
  if (!query || query.trim().length < 2) {
    throw new AdminError('Requête de recherche trop courte (2 caractères min.)', 400);
  }
  return prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: query.trim() } },
        { fullName: { contains: query.trim(), mode: 'insensitive' } },
      ],
    },
    select: { id: true, phone: true, fullName: true, status: true, accountType: true, createdAt: true },
    take: 20,
  });
}

async function getUserDetail(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { kycProfile: true, businessProfile: true },
  });
  if (!user) throw new AdminError('Utilisateur introuvable', 404);

  const [wallet, recentHistory] = await Promise.all([
    walletService.getBalance(userId).catch(() => null),
    walletService.getHistory(userId).catch(() => []),
  ]);

  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    status: user.status,
    accountType: user.accountType,
    declaresCommercialUse: user.declaresCommercialUse,
    createdAt: user.createdAt,
    kycTier: user.kycProfile?.tier || 'TIER_0',
    kycReviewStatus: user.kycProfile?.reviewStatus || 'NONE',
    businessReviewStatus: user.businessProfile?.reviewStatus || null,
    wallet,
    recentHistory: recentHistory.slice(0, 10),
  };
}

// Action support la plus courante en pratique : un utilisateur bloqué à
// l'inscription qui n'a jamais reçu son SMS. Fonctionne uniquement tant
// que le compte n'est pas déjà vérifié - pas un moyen de renvoyer un OTP
// sensible à volonté.
async function resendVerificationOtp(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AdminError('Utilisateur introuvable', 404);
  if (user.status !== 'PENDING_VERIFICATION') {
    throw new AdminError('Ce compte a déjà vérifié son numéro - rien à renvoyer', 400);
  }
  await authService.sendVerificationOtp(user);
  return { sent: true };
}

// --- Modération des champs de paiement personnalisés ------------------------
// Une institution crée librement ses propres champs (voir
// businessPaymentFields.service.js) - un libellé est un texte libre,
// jamais filtré automatiquement. Ceci donne à l'admin une visibilité sur
// TOUS les champs créés par TOUTES les institutions, et la possibilité
// d'en supprimer un de force en cas d'usage inapproprié (ex: un libellé
// injurieux ou trompeur), sans dépendre de l'institution elle-même pour
// le corriger.

async function listAllPaymentFields(query = {}) {
  const { page, pageSize, skip, take } = parsePagination(query);

  const [items, total] = await Promise.all([
    prisma.businessPaymentField.findMany({
      include: { businessProfile: { select: { businessName: true, userId: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.businessPaymentField.count(),
  ]);

  return buildPaginatedResult(items, total, page, pageSize);
}

async function forceDeletePaymentField(adminId, fieldId) {
  const field = await prisma.businessPaymentField.findUnique({
    where: { id: fieldId },
    include: { businessProfile: { select: { businessName: true, userId: true } } },
  });
  if (!field) throw new AdminError('Champ introuvable', 404);

  await prisma.businessPaymentField.delete({ where: { id: fieldId } });

  await prisma.auditLog.create({
    data: {
      userId: field.businessProfile.userId,
      action: 'PAYMENT_FIELD_FORCE_DELETED_BY_ADMIN',
      metadata: { fieldId, label: field.label, adminId, businessName: field.businessProfile.businessName },
    },
  });

  return { deleted: true };
}

// --- Tableau de bord interne FlexPay (volume, revenus, activité) -----------
// Répond à un besoin distinct de tout le reste de la console admin : les
// autres écrans servent à AGIR (valider un KYC, geler un compte...),
// celui-ci sert à COMPRENDRE comment se porte le produit. Aucune nouvelle
// infrastructure de tracking - tout est dérivé des données déjà en base
// (Transaction, User, BusinessProfile).
async function getBusinessMetrics({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    usersByTier,
    newSignups,
    approvedEnterprises,
    approvedMerchants,
    pendingKycCount,
    pendingKybCount,
    volumeByType,
    revenueAgg,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.kycProfile.groupBy({ by: ['tier'], _count: { _all: true } }),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.businessProfile.count({ where: { reviewStatus: 'APPROVED', user: { accountType: 'BUSINESS' } } }),
    prisma.businessProfile.count({ where: { reviewStatus: 'APPROVED', user: { accountType: 'MERCHANT' } } }),
    prisma.kycProfile.count({ where: { reviewStatus: 'PENDING' } }),
    prisma.businessProfile.count({ where: { reviewStatus: 'PENDING' } }),
    prisma.transaction.groupBy({
      by: ['type'],
      where: { createdAt: { gte: since }, status: 'COMPLETED' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'FEE', createdAt: { gte: since }, status: 'COMPLETED' },
      _sum: { amount: true },
    }),
  ]);

  return {
    period: { days, since },
    users: {
      total: totalUsers,
      newSignups,
      byTier: Object.fromEntries(usersByTier.map((t) => [t.tier, t._count._all])),
    },
    business: {
      approved: approvedEnterprises + approvedMerchants,
      approvedEnterprises,
      approvedMerchants,
      pendingKyc: pendingKycCount,
      pendingKyb: pendingKybCount,
    },
    volume: Object.fromEntries(
      volumeByType.map((t) => [t.type, { amount: Number(t._sum.amount || 0), count: t._count._all }])
    ),
    revenue: Number(revenueAgg._sum.amount || 0),
  };
}

module.exports = {
  AdminError,
  listPendingKyc,
  reviewKyc,
  listPendingKyb,
  reviewKyb,
  createApiClient,
  listApiClients,
  revokeApiClient,
  listSuspiciousFanIn,
  listStructuringPatterns,
  dismissRiskAlert,
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  listAuditLog,
  searchUsers,
  getUserDetail,
  resendVerificationOtp,
  listAllPaymentFields,
  forceDeletePaymentField,
  getBusinessMetrics,
};

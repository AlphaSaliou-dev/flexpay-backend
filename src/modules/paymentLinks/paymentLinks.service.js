const crypto = require('crypto');
const prisma = require('../../config/db');
const { payBusiness, payBusinessGuest } = require('../payments/payments.service');
const { listFieldsForPayer } = require('../payments/businessPaymentFields.service');
const externalPaymentsService = require('../externalPayments/externalPayments.service');

class PaymentLinkError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Code public opaque (dans l'URL partagée sur les réseaux sociaux) -
// jamais l'id interne, pour ne rien révéler sur le nombre de liens créés
// par une institution. ~72 bits d'entropie (9 octets en base64url) :
// pas besoin de hash comme pour une clé API, ce n'est pas un secret
// d'authentification, juste un identifiant de lookup non devinable.
function generateLinkCode() {
  return crypto.randomBytes(9).toString('base64url');
}

// Durée de vie fixe d'un lien, imposée par le serveur : jamais choisie par
// le marchand (ni à la création, ni à la réactivation), pour qu'un lien
// partagé ne reste pas payable indéfiniment sans que l'institution y
// repense.
const LINK_LIFETIME_MS = 48 * 60 * 60 * 1000;

async function requireApprovedBusiness(businessUserId) {
  const user = await prisma.user.findUnique({
    where: { id: businessUserId },
    include: { businessProfile: true },
  });

  if (!user || !['BUSINESS', 'MERCHANT'].includes(user.accountType) || !user.businessProfile) {
    throw new PaymentLinkError('Seul un compte Business ou Marchand peut créer un lien de paiement', 403);
  }
  if (user.businessProfile.reviewStatus !== 'APPROVED') {
    throw new PaymentLinkError("Ce compte n'est pas encore validé", 403);
  }
  return user.businessProfile;
}

async function createPaymentLink(businessUserId, { label, amount }) {
  const businessProfile = await requireApprovedBusiness(businessUserId);

  // Collision quasi impossible (72 bits) mais on reste défensif plutôt que
  // de laisser une erreur de contrainte unique remonter telle quelle.
  let code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateLinkCode();
    const existing = await prisma.paymentLink.findUnique({ where: { code: candidate } });
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new PaymentLinkError('Impossible de générer un lien, réessayez', 500);

  return prisma.paymentLink.create({
    data: {
      code,
      businessProfileId: businessProfile.id,
      label,
      amount,
      expiresAt: new Date(Date.now() + LINK_LIFETIME_MS),
    },
  });
}

async function listPaymentLinksForBusiness(businessUserId) {
  const businessProfile = await requireApprovedBusiness(businessUserId);
  return prisma.paymentLink.findMany({
    where: { businessProfileId: businessProfile.id },
    orderBy: { createdAt: 'desc' },
  });
}

async function toggleActive(businessUserId, linkId, active) {
  const businessProfile = await requireApprovedBusiness(businessUserId);
  const link = await prisma.paymentLink.findUnique({ where: { id: linkId } });

  // Même erreur qu'un id inexistant si le lien appartient à une autre
  // entreprise - ne jamais révéler qu'un lien d'un tiers existe bel et
  // bien (même logique que getBulkPayoutSummaryForBusiness).
  if (!link || link.businessProfileId !== businessProfile.id) {
    throw new PaymentLinkError('Lien de paiement introuvable', 404);
  }

  return prisma.paymentLink.update({ where: { id: linkId }, data: { active } });
}

// Un lien expiré ne se "dé-expire" pas en le remettant simplement actif -
// le marchand doit explicitement le réactiver, ce qui lui redonne la même
// fenêtre fixe de 48h (jamais plus, jamais une date choisie par lui).
async function reactivate(businessUserId, linkId) {
  const businessProfile = await requireApprovedBusiness(businessUserId);
  const link = await prisma.paymentLink.findUnique({ where: { id: linkId } });

  if (!link || link.businessProfileId !== businessProfile.id) {
    throw new PaymentLinkError('Lien de paiement introuvable', 404);
  }

  return prisma.paymentLink.update({
    where: { id: linkId },
    data: { active: true, expiresAt: new Date(Date.now() + LINK_LIFETIME_MS) },
  });
}

// Public, aucune authentification - c'est justement le but : quelqu'un
// qui clique le lien depuis les réseaux sociaux doit voir ce qu'il va
// payer avant même de se connecter. On ne révèle que le strict
// nécessaire (jamais l'id interne, le nombre de paiements, etc.).
async function getPublicLinkInfo(code) {
  const link = await prisma.paymentLink.findUnique({
    where: { code },
    include: { businessProfile: true },
  });

  if (!link) throw new PaymentLinkError('Lien de paiement introuvable', 404);

  const expired = Boolean(link.expiresAt && link.expiresAt < new Date());

  // Définitions des champs demandés par l'institution (ex: "Nom de
  // l'élève") - permet à la page publique de les afficher AVANT le
  // paiement, comme le fait déjà l'écran de paiement marchand in-app.
  const customFields = await listFieldsForPayer(link.businessProfile.userId);

  return {
    label: link.label,
    businessName: link.businessProfile.businessName,
    amount: link.amount != null ? Number(link.amount) : null, // null = lien historique sans montant (invalide, voir payViaLink)
    status: !link.active ? 'INACTIVE' : expired ? 'EXPIRED' : 'ACTIVE',
    mobileMoneyMethods: externalPaymentsService.EXTERNAL_PAYMENT_METHODS,
    customFields,
  };
}

// Coeur du paiement par lien : réutilise payBusiness (même commission,
// mêmes plafonds, même ledger) plutôt que de dupliquer cette logique -
// le lien n'est qu'une autre porte d'entrée vers le même paiement
// marchand, pas un flux d'argent différent.
async function payViaLink(payerUserId, code, { idempotencyKey, customFields }) {
  const link = await prisma.paymentLink.findUnique({
    where: { code },
    include: { businessProfile: true },
  });

  if (!link) throw new PaymentLinkError('Lien de paiement introuvable', 404);
  if (!link.active) throw new PaymentLinkError("Ce lien de paiement n'est plus actif", 410);
  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new PaymentLinkError('Ce lien de paiement a expiré', 410);
  }

  // Montant fixe imposé par le lien, jamais envoyé par le payeur, pour
  // qu'un client ne puisse pas altérer le prix d'un produit affiché. Un
  // lien créé avant l'obligation de montant (donnée historique) ne peut
  // simplement plus être payé - l'institution doit en recréer un.
  if (link.amount == null) {
    throw new PaymentLinkError('Ce lien de paiement est invalide (aucun montant défini)', 400);
  }
  const finalAmount = Number(link.amount);

  const result = await payBusiness({
    payerUserId,
    businessUserId: link.businessProfile.userId,
    amount: finalAmount,
    idempotencyKey,
    metadata: { paymentLinkId: link.id, channel: 'payment_link' },
    customFields,
  });

  await prisma.paymentLink.update({
    where: { id: link.id },
    data: { paymentCount: { increment: 1 } },
  });

  return {
    payment: result.payment,
    feeAmount: result.feeAmount,
    amountPaid: finalAmount,
  };
}

// Paiement invité via Mobile Money ou carte (Orange Money, MTN, carte
// bancaire) : le client n'a pas besoin d'un compte FlexPay. La
// "confirmation" (externalPaymentsService.collect) est mockée - toujours
// un succès immédiat tant qu'aucun partenaire réel n'est branché (voir
// externalPayments.service.js). L'argent reçu atterrit directement sur le
// wallet FlexPay du marchand, commission déduite, exactement comme un
// paiement classique.
async function payViaLinkMobileMoney(code, { phone, provider, idempotencyKey, customFields }) {
  const link = await prisma.paymentLink.findUnique({
    where: { code },
    include: { businessProfile: true },
  });

  if (!link) throw new PaymentLinkError('Lien de paiement introuvable', 404);
  if (!link.active) throw new PaymentLinkError("Ce lien de paiement n'est plus actif", 410);
  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new PaymentLinkError('Ce lien de paiement a expiré', 410);
  }
  if (link.amount == null) {
    throw new PaymentLinkError('Ce lien de paiement est invalide (aucun montant défini)', 400);
  }
  const finalAmount = Number(link.amount);

  const collection = await externalPaymentsService.collect({ phone, amount: finalAmount, provider });
  if (collection.status !== 'COMPLETED') {
    throw new PaymentLinkError('Le paiement Mobile Money a échoué, réessayez', 402);
  }

  const result = await payBusinessGuest({
    businessUserId: link.businessProfile.userId,
    amount: finalAmount,
    payerPhone: phone,
    idempotencyKey,
    metadata: {
      paymentLinkId: link.id,
      channel: 'payment_link_mobile_money',
      mobileMoneyProvider: provider,
      providerReference: collection.providerReference,
    },
    customFields,
  });

  await prisma.paymentLink.update({
    where: { id: link.id },
    data: { paymentCount: { increment: 1 } },
  });

  return {
    payment: result.payment,
    feeAmount: result.feeAmount,
    amountPaid: finalAmount,
  };
}

module.exports = {
  PaymentLinkError,
  LINK_LIFETIME_MS,
  createPaymentLink,
  listPaymentLinksForBusiness,
  toggleActive,
  reactivate,
  getPublicLinkInfo,
  payViaLink,
  payViaLinkMobileMoney,
};

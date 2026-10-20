const prisma = require('../../config/db');

class BeneficiaryGroupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Réservé à l'Entreprise, jamais au Marchand - même règle que l'envoi du
// lot lui-même (voir bulkPayout.service.createBulkPayout). Une liste de
// bénéficiaires n'a d'usage que pour le paiement en masse ou le per diem,
// tous les deux déjà réservés à l'Entreprise ; sans ce contrôle, un compte
// Marchand pouvait créer/lire des listes directement via l'API même si le
// frontend lui masque l'onglet.
async function assertEligibleBusiness(businessUserId) {
  const user = await prisma.user.findUnique({ where: { id: businessUserId } });
  if (!user || user.accountType !== 'BUSINESS') {
    throw new BeneficiaryGroupError('Les listes de bénéficiaires sont réservées aux comptes Entreprise', 403);
  }
}

async function createGroup(businessUserId, { name, members }) {
  await assertEligibleBusiness(businessUserId);
  return prisma.beneficiaryGroup.create({
    data: {
      businessUserId,
      name,
      members: { create: members },
    },
    include: { members: true },
  });
}

async function listGroups(businessUserId) {
  await assertEligibleBusiness(businessUserId);
  const groups = await prisma.beneficiaryGroup.findMany({
    where: { businessUserId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { members: true } } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g._count.members,
    updatedAt: g.updatedAt,
  }));
}

async function getGroup(businessUserId, groupId) {
  await assertEligibleBusiness(businessUserId);
  const group = await prisma.beneficiaryGroup.findUnique({
    where: { id: groupId },
    include: { members: true },
  });
  if (!group || group.businessUserId !== businessUserId) {
    // Même erreur qu'un id inexistant - ne jamais révéler qu'une liste
    // appartenant à quelqu'un d'autre existe.
    throw new BeneficiaryGroupError('Liste de bénéficiaires introuvable', 404);
  }
  return group;
}

// Remplace intégralement les membres plutôt que de les fusionner - une
// mise à jour reflète la composition actuelle réelle de l'équipe (départs,
// arrivées), pas un empilement de tous les membres ayant jamais existé.
async function updateGroup(businessUserId, groupId, { name, members }) {
  await getGroup(businessUserId, groupId); // vérifie la propriété avant toute écriture

  return prisma.beneficiaryGroup.update({
    where: { id: groupId },
    data: {
      name,
      members: { deleteMany: {}, create: members },
    },
    include: { members: true },
  });
}

async function deleteGroup(businessUserId, groupId) {
  await getGroup(businessUserId, groupId);
  // Les membres n'ont pas de suppression en cascade au niveau du schéma -
  // les retirer explicitement avant le groupe, dans la même transaction,
  // évite la violation de contrainte de clé étrangère.
  await prisma.$transaction([
    prisma.beneficiaryGroupMember.deleteMany({ where: { groupId } }),
    prisma.beneficiaryGroup.delete({ where: { id: groupId } }),
  ]);
}

module.exports = { BeneficiaryGroupError, createGroup, listGroups, getGroup, updateGroup, deleteGroup };

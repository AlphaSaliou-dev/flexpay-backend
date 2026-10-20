const mockPrisma = {
  beneficiaryGroup: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const groupsService = require('../../src/modules/bulkPayout/beneficiaryGroups.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
});

describe('createGroup', () => {
  test('crée le groupe avec ses membres imbriqués', async () => {
    mockPrisma.beneficiaryGroup.create.mockResolvedValue({ id: 'g1' });

    await groupsService.createGroup('biz-1', {
      name: 'Employés École',
      members: [{ phone: '+224620000001', defaultAmount: 500000 }],
    });

    const call = mockPrisma.beneficiaryGroup.create.mock.calls[0][0];
    expect(call.data.businessUserId).toBe('biz-1');
    expect(call.data.members.create).toHaveLength(1);
  });
});

describe('getGroup - propriété vérifiée', () => {
  test('rejette avec le même message qu\'un id inexistant si le groupe appartient à une autre entreprise', async () => {
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'g1', businessUserId: 'autre-entreprise' });

    await expect(groupsService.getGroup('biz-1', 'g1')).rejects.toThrow('introuvable');
  });

  test('autorise l\'accès au propriétaire réel', async () => {
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'g1', businessUserId: 'biz-1', members: [] });

    const result = await groupsService.getGroup('biz-1', 'g1');
    expect(result.id).toBe('g1');
  });
});

describe('updateGroup', () => {
  test('remplace intégralement les membres (deleteMany + create), jamais un ajout cumulatif', async () => {
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'g1', businessUserId: 'biz-1', members: [] });
    mockPrisma.beneficiaryGroup.update.mockResolvedValue({ id: 'g1' });

    await groupsService.updateGroup('biz-1', 'g1', {
      name: 'Employés École (mise à jour)',
      members: [{ phone: '+224620000002', defaultAmount: 600000 }],
    });

    const call = mockPrisma.beneficiaryGroup.update.mock.calls[0][0];
    expect(call.data.members.deleteMany).toEqual({});
    expect(call.data.members.create).toHaveLength(1);
  });

  test('vérifie la propriété AVANT toute écriture', async () => {
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'g1', businessUserId: 'autre-entreprise' });

    await expect(
      groupsService.updateGroup('biz-1', 'g1', { name: 'x', members: [] })
    ).rejects.toThrow('introuvable');

    expect(mockPrisma.beneficiaryGroup.update).not.toHaveBeenCalled();
  });
});

describe('deleteGroup', () => {
  test('vérifie la propriété avant suppression', async () => {
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'g1', businessUserId: 'autre-entreprise' });

    await expect(groupsService.deleteGroup('biz-1', 'g1')).rejects.toThrow('introuvable');
    expect(mockPrisma.beneficiaryGroup.delete).not.toHaveBeenCalled();
  });
});

describe('listGroups', () => {
  test('retourne un résumé (nombre de membres) plutôt que la liste complète', async () => {
    mockPrisma.beneficiaryGroup.findMany.mockResolvedValue([
      { id: 'g1', name: 'Équipe A', updatedAt: new Date(), _count: { members: 12 } },
    ]);

    const result = await groupsService.listGroups('biz-1');
    expect(result[0].memberCount).toBe(12);
    expect(result[0].members).toBeUndefined();
  });
});

describe('réservé aux comptes Entreprise, jamais au Marchand (même règle que le paiement en masse lui-même)', () => {
  test('createGroup rejette un compte MERCHANT', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'merchant-1', accountType: 'MERCHANT' });

    await expect(
      groupsService.createGroup('merchant-1', { name: 'x', members: [] })
    ).rejects.toThrow(/réservées aux comptes Entreprise/);
    expect(mockPrisma.beneficiaryGroup.create).not.toHaveBeenCalled();
  });

  test('listGroups rejette un compte MERCHANT', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'merchant-1', accountType: 'MERCHANT' });

    await expect(groupsService.listGroups('merchant-1')).rejects.toThrow(/réservées aux comptes Entreprise/);
    expect(mockPrisma.beneficiaryGroup.findMany).not.toHaveBeenCalled();
  });

  test('getGroup rejette un compte MERCHANT, même propriétaire du groupe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'merchant-1', accountType: 'MERCHANT' });

    await expect(groupsService.getGroup('merchant-1', 'g1')).rejects.toThrow(/réservées aux comptes Entreprise/);
    expect(mockPrisma.beneficiaryGroup.findUnique).not.toHaveBeenCalled();
  });

  test('updateGroup et deleteGroup rejettent aussi un compte MERCHANT (via getGroup)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'merchant-1', accountType: 'MERCHANT' });

    await expect(groupsService.updateGroup('merchant-1', 'g1', { name: 'x', members: [] })).rejects.toThrow(/réservées aux comptes Entreprise/);
    await expect(groupsService.deleteGroup('merchant-1', 'g1')).rejects.toThrow(/réservées aux comptes Entreprise/);
    expect(mockPrisma.beneficiaryGroup.update).not.toHaveBeenCalled();
    expect(mockPrisma.beneficiaryGroup.delete).not.toHaveBeenCalled();
  });

  test('rejette aussi un compte INDIVIDUAL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL' });

    await expect(groupsService.listGroups('user-1')).rejects.toThrow(/réservées aux comptes Entreprise/);
  });
});

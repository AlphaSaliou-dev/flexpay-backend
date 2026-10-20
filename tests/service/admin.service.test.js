const mockPrisma = {
  auditLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  kycProfile: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  businessProfile: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
  businessPaymentField: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  transaction: { groupBy: jest.fn(), aggregate: jest.fn() },
  apiClient: { create: jest.fn(), findMany: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockSendVerificationOtp = jest.fn();
jest.mock('../../src/modules/auth/auth.service', () => ({
  sendVerificationOtp: (...args) => mockSendVerificationOtp(...args),
}));

const mockGetBalance = jest.fn();
const mockGetHistory = jest.fn();
jest.mock('../../src/modules/wallet/wallet.service', () => ({
  getBalance: (...args) => mockGetBalance(...args),
  getHistory: (...args) => mockGetHistory(...args),
}));

const adminService = require('../../src/modules/admin/admin.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createApiClient - durcissement sécurité (expiresAt, allowedIps)', () => {
  test('rejette pour un compte qui n\'est pas Business', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', accountType: 'INDIVIDUAL' });

    await expect(
      adminService.createApiClient({ name: 'Partenaire', businessUserId: 'u1', environment: 'LIVE' })
    ).rejects.toThrow(/Business valide/);
  });

  test('rejette si le KYB n\'est pas encore approuvé', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', accountType: 'BUSINESS' });
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);
    // findUnique dédié au profil business (distinct de user.findUnique)
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ reviewStatus: 'PENDING' });

    await expect(
      adminService.createApiClient({ name: 'Partenaire', businessUserId: 'u1', environment: 'LIVE' })
    ).rejects.toThrow(/validé \(KYB\)/);
  });

  test('expiresAt et allowedIps sont null/vide par défaut si non fournis (comportement historique préservé)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', accountType: 'BUSINESS' });
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ reviewStatus: 'APPROVED' });
    mockPrisma.apiClient.create.mockResolvedValue({ id: 'client-1' });

    await adminService.createApiClient({ name: 'Partenaire', businessUserId: 'u1', environment: 'LIVE' });

    const call = mockPrisma.apiClient.create.mock.calls[0][0];
    expect(call.data.expiresAt).toBeNull();
    expect(call.data.allowedIps).toEqual([]);
  });

  test('transmet expiresAt et allowedIps quand fournis par l\'admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', accountType: 'BUSINESS' });
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ reviewStatus: 'APPROVED' });
    mockPrisma.apiClient.create.mockResolvedValue({ id: 'client-1' });

    const expiresAt = new Date('2027-01-01');
    await adminService.createApiClient({
      name: 'Partenaire', businessUserId: 'u1', environment: 'LIVE', expiresAt, allowedIps: ['41.207.0.1'],
    });

    const call = mockPrisma.apiClient.create.mock.calls[0][0];
    expect(call.data.expiresAt).toBe(expiresAt);
    expect(call.data.allowedIps).toEqual(['41.207.0.1']);
  });
});

describe('listAuditLog', () => {
  test('applique la pagination et retourne le total', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
    mockPrisma.auditLog.count.mockResolvedValue(1);

    const result = await adminService.listAuditLog({ page: '1', pageSize: '20' });

    expect(result.items).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });

  test('filtre par userId et par action quand fournis', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    mockPrisma.auditLog.count.mockResolvedValue(0);

    await adminService.listAuditLog({ userId: 'user-1', action: 'LOGIN_FAILED' });

    expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      action: 'LOGIN_FAILED',
    });
  });
});

describe('searchUsers', () => {
  test('rejette une requête trop courte', async () => {
    await expect(adminService.searchUsers('a')).rejects.toThrow(/trop courte/);
  });

  test('cherche à la fois par téléphone et par nom', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    await adminService.searchUsers('Aminata');

    const whereClause = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(whereClause.OR).toHaveLength(2);
  });
});

describe('getUserDetail', () => {
  test('rejette si l\'utilisateur n\'existe pas', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(adminService.getUserDetail('inconnu')).rejects.toThrow('introuvable');
  });

  test('assemble le profil, le solde et l\'historique en une seule fiche', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1', phone: '+224620000000', fullName: 'Aminata', status: 'ACTIVE',
      accountType: 'INDIVIDUAL', declaresCommercialUse: false, createdAt: new Date(),
      kycProfile: { tier: 'TIER_1', reviewStatus: 'NONE' },
      businessProfile: null,
    });
    mockGetBalance.mockResolvedValue({ balance: 500000, currency: 'GNF' });
    mockGetHistory.mockResolvedValue(new Array(15).fill({ type: 'DEPOSIT' }));

    const detail = await adminService.getUserDetail('user-1');

    expect(detail.kycTier).toBe('TIER_1');
    expect(detail.wallet.balance).toBe(500000);
    // La fiche ne montre que les 10 dernières opérations, pas tout l'historique brut.
    expect(detail.recentHistory).toHaveLength(10);
  });

  test('ne plante jamais si le wallet ou l\'historique échouent à charger', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1', phone: '+224620000000', fullName: null, status: 'ACTIVE',
      accountType: 'INDIVIDUAL', declaresCommercialUse: false, createdAt: new Date(),
      kycProfile: null, businessProfile: null,
    });
    mockGetBalance.mockRejectedValue(new Error('DB down'));
    mockGetHistory.mockRejectedValue(new Error('DB down'));

    const detail = await adminService.getUserDetail('user-1');
    expect(detail.wallet).toBeNull();
    expect(detail.recentHistory).toEqual([]);
  });
});

describe('resendVerificationOtp', () => {
  test('rejette si le compte est déjà vérifié', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });
    await expect(adminService.resendVerificationOtp('user-1')).rejects.toThrow(/déjà vérifié/);
    expect(mockSendVerificationOtp).not.toHaveBeenCalled();
  });

  test('renvoie bien un OTP pour un compte en attente de vérification', async () => {
    const user = { id: 'user-1', status: 'PENDING_VERIFICATION' };
    mockPrisma.user.findUnique.mockResolvedValue(user);

    const result = await adminService.resendVerificationOtp('user-1');

    expect(mockSendVerificationOtp).toHaveBeenCalledWith(user);
    expect(result).toEqual({ sent: true });
  });
});

describe('listAllPaymentFields - visibilité admin sur les champs créés par toutes les institutions', () => {
  test('inclut le nom de l\'institution propriétaire de chaque champ', async () => {
    mockPrisma.businessPaymentField.findMany.mockResolvedValue([
      { id: 'f1', label: 'Nom de l\'élève', businessProfile: { businessName: 'École Sainte Marie', userId: 'biz-1' } },
    ]);
    mockPrisma.businessPaymentField.count.mockResolvedValue(1);

    const result = await adminService.listAllPaymentFields();

    expect(result.items[0].businessProfile.businessName).toBe('École Sainte Marie');
  });
});

describe('forceDeletePaymentField - modération admin', () => {
  test('rejette si le champ est introuvable', async () => {
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue(null);
    await expect(adminService.forceDeletePaymentField('admin-1', 'f1')).rejects.toThrow('introuvable');
    expect(mockPrisma.businessPaymentField.delete).not.toHaveBeenCalled();
  });

  test('supprime le champ et journalise l\'action avec l\'admin responsable et le libellé supprimé', async () => {
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue({
      id: 'f1', label: 'Libellé inapproprié',
      businessProfile: { businessName: 'École Test', userId: 'biz-1' },
    });
    mockPrisma.businessPaymentField.delete.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    await adminService.forceDeletePaymentField('admin-1', 'f1');

    expect(mockPrisma.businessPaymentField.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });

    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(auditCall.action).toBe('PAYMENT_FIELD_FORCE_DELETED_BY_ADMIN');
    expect(auditCall.userId).toBe('biz-1'); // l'institution concernée, pas l'admin
    expect(auditCall.metadata.adminId).toBe('admin-1');
    expect(auditCall.metadata.label).toBe('Libellé inapproprié');
  });
});

describe('getBusinessMetrics - tableau de bord interne', () => {
  test('ne compte que les transactions FEE comme revenu, jamais les autres types', async () => {
    mockPrisma.user.count.mockResolvedValue(100);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([{ tier: 'TIER_2', _count: { _all: 40 } }]);
    mockPrisma.businessProfile.count.mockResolvedValue(5);
    mockPrisma.kycProfile.count.mockResolvedValue(3);
    mockPrisma.transaction.groupBy.mockResolvedValue([]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 125000 } });

    const result = await adminService.getBusinessMetrics();

    const aggregateCall = mockPrisma.transaction.aggregate.mock.calls[0][0];
    expect(aggregateCall.where.type).toBe('FEE');
    expect(aggregateCall.where.status).toBe('COMPLETED');
    expect(result.revenue).toBe(125000);
  });

  test('ne compte le volume que sur les transactions COMPLETED (jamais PENDING ou FAILED)', async () => {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([]);
    mockPrisma.businessProfile.count.mockResolvedValue(0);
    mockPrisma.kycProfile.count.mockResolvedValue(0);
    mockPrisma.transaction.groupBy.mockResolvedValue([
      { type: 'DEPOSIT', _sum: { amount: 5000000 }, _count: { _all: 12 } },
    ]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const result = await adminService.getBusinessMetrics();

    const groupByCall = mockPrisma.transaction.groupBy.mock.calls[0][0];
    expect(groupByCall.where.status).toBe('COMPLETED');
    expect(result.volume.DEPOSIT).toEqual({ amount: 5000000, count: 12 });
  });

  test('respecte la période demandée (days) pour filtrer les nouvelles inscriptions et le volume', async () => {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([]);
    mockPrisma.businessProfile.count.mockResolvedValue(0);
    mockPrisma.kycProfile.count.mockResolvedValue(0);
    mockPrisma.transaction.groupBy.mockResolvedValue([]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    await adminService.getBusinessMetrics({ days: 7 });

    const groupByCall = mockPrisma.transaction.groupBy.mock.calls[0][0];
    const daysDiff = (Date.now() - groupByCall.where.createdAt.gte.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysDiff).toBeCloseTo(7, 0);
  });

  test('utilise 30 jours par défaut si aucune période n\'est précisée', async () => {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([]);
    mockPrisma.businessProfile.count.mockResolvedValue(0);
    mockPrisma.kycProfile.count.mockResolvedValue(0);
    mockPrisma.transaction.groupBy.mockResolvedValue([]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const result = await adminService.getBusinessMetrics();

    expect(result.period.days).toBe(30);
  });

  test('distingue les comptes Entreprise et Marchand approuvés (deux comptages séparés)', async () => {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([]);
    mockPrisma.kycProfile.count.mockResolvedValue(0);
    mockPrisma.businessProfile.count
      .mockResolvedValueOnce(12) // approvedEnterprises
      .mockResolvedValueOnce(34) // approvedMerchants
      .mockResolvedValueOnce(2); // pendingKybCount
    mockPrisma.transaction.groupBy.mockResolvedValue([]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const result = await adminService.getBusinessMetrics();

    expect(result.business.approvedEnterprises).toBe(12);
    expect(result.business.approvedMerchants).toBe(34);
    expect(result.business.approved).toBe(46);

    const enterpriseCall = mockPrisma.businessProfile.count.mock.calls[0][0];
    const merchantCall = mockPrisma.businessProfile.count.mock.calls[1][0];
    expect(enterpriseCall.where.user.accountType).toBe('BUSINESS');
    expect(merchantCall.where.user.accountType).toBe('MERCHANT');
  });

  test('gère un revenu ou un volume nul sans planter (pas de transaction sur la période)', async () => {
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.kycProfile.groupBy.mockResolvedValue([]);
    mockPrisma.businessProfile.count.mockResolvedValue(0);
    mockPrisma.kycProfile.count.mockResolvedValue(0);
    mockPrisma.transaction.groupBy.mockResolvedValue([]);
    mockPrisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: null } });

    const result = await adminService.getBusinessMetrics();

    expect(result.revenue).toBe(0);
  });
});

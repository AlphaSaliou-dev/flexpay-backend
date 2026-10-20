const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  kycProfile: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  businessProfile: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn((ops) => Promise.all(ops)),
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockScreenName = jest.fn();
const mockScreenNames = jest.fn();
jest.mock('../../src/modules/compliance/sanctionsScreening.service', () => ({
  screenName: (...args) => mockScreenName(...args),
  screenNames: (...args) => mockScreenNames(...args),
}));

const mockCompareIdWithSelfie = jest.fn();
jest.mock('../../src/modules/kyc/faceMatch.service', () => ({
  compareIdWithSelfie: (...args) => mockCompareIdWithSelfie(...args),
}));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const kycService = require('../../src/modules/kyc/kyc.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL' });
  mockScreenName.mockResolvedValue({ hit: false, matches: [] });
  mockScreenNames.mockResolvedValue({ hit: false, matches: [] });
  mockCompareIdWithSelfie.mockResolvedValue({ status: 'INCONCLUSIVE', score: null });
});

describe('submitTier1 - filtrage sanctions', () => {
  test('appelle le filtrage avec le nom déclaré, et stocke un résultat "propre"', async () => {
    await kycService.submitTier1('user-1', { fullName: 'Mariama Camara', dateOfBirth: '1995-01-01' });

    expect(mockScreenName).toHaveBeenCalledWith('Mariama Camara');
    const kycProfileCall = mockPrisma.kycProfile.upsert.mock.calls[0][0];
    expect(kycProfileCall.create.sanctionsHit).toBe(false);
  });

  test('stocke un hit et enregistre un événement d\'audit dédié si le filtrage remonte une correspondance', async () => {
    const matches = [{ entityId: 'e1', score: 0.05 }];
    mockScreenName.mockResolvedValue({ hit: true, matches });

    await kycService.submitTier1('user-1', { fullName: 'Jean Test Sanctionné', dateOfBirth: '1980-01-01' });

    const kycProfileCall = mockPrisma.kycProfile.upsert.mock.calls[0][0];
    expect(kycProfileCall.create.sanctionsHit).toBe(true);
    expect(kycProfileCall.create.sanctionsDetails).toEqual(matches);

    const auditCalls = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).toContain('SANCTIONS_SCREENING_HIT');
  });

  test('un compte non filtré ne déclenche aucun audit de sanctions', async () => {
    await kycService.submitTier1('user-1', { fullName: 'Mariama Camara', dateOfBirth: '1995-01-01' });

    const auditCalls = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).not.toContain('SANCTIONS_SCREENING_HIT');
  });
});

describe('submitTier2 - correspondance faciale (selfie)', () => {
  const tier2Payload = {
    idDocumentType: 'CNI',
    idDocumentNumber: 'GN0123456',
    idDocumentUrl: '/api/v1/files/id-doc-1',
    selfieUrl: '/api/v1/files/selfie-1',
  };

  test('appelle la comparaison faciale avec les deux fichiers fournis', async () => {
    await kycService.submitTier2('user-1', tier2Payload);

    expect(mockCompareIdWithSelfie).toHaveBeenCalledWith('/api/v1/files/id-doc-1', '/api/v1/files/selfie-1');
  });

  test('stocke le statut et le score de correspondance sur le profil KYC', async () => {
    mockCompareIdWithSelfie.mockResolvedValue({ status: 'MATCH', score: 0.94 });

    await kycService.submitTier2('user-1', tier2Payload);

    const call = mockPrisma.kycProfile.upsert.mock.calls[0][0];
    expect(call.create.faceMatchStatus).toBe('MATCH');
    expect(call.create.faceMatchScore).toBe(0.94);
  });

  test('un échec de la comparaison (ex: fichier illisible) ne bloque jamais la soumission - juste INCONCLUSIVE', async () => {
    mockCompareIdWithSelfie.mockRejectedValue(new Error('Fichier introuvable'));

    const result = await kycService.submitTier2('user-1', tier2Payload);

    expect(result.faceMatchStatus).toBe('INCONCLUSIVE');
    const call = mockPrisma.kycProfile.upsert.mock.calls[0][0];
    expect(call.create.faceMatchStatus).toBe('INCONCLUSIVE');
  });

  test('reste en TIER_1 tant que la revue n\'a pas eu lieu, peu importe le résultat de la correspondance', async () => {
    mockCompareIdWithSelfie.mockResolvedValue({ status: 'MATCH', score: 0.99 });

    await kycService.submitTier2('user-1', tier2Payload);

    const call = mockPrisma.kycProfile.upsert.mock.calls[0][0];
    expect(call.create.tier).toBe('TIER_1');
    expect(call.create.reviewStatus).toBe('PENDING');
  });

  test('confirme la réception du dossier (avant même la revue)', async () => {
    await kycService.submitTier2('user-1', tier2Payload);

    expect(mockNotifyUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ type: 'KYC_SUBMITTED' }));
  });
});

describe('submitBusinessKyc - filtrage sanctions et bénéficiaires effectifs (UBO)', () => {
  function makeBusinessPayload(overrides = {}) {
    return {
      businessName: 'École Sainte Marie',
      rccmNumber: 'GC-KAL-001',
      nifNumber: '0123456',
      legalRepName: 'Aminata Diallo',
      legalRepIdDocumentUrl: 'https://example.com/id.jpg',
      businessDocumentUrl: 'https://example.com/rccm.pdf',
      ubos: [{ fullName: 'Fatoumata Bah', ownershipPercentage: 60, idDocumentUrl: 'https://example.com/ubo1.jpg' }],
      ...overrides,
    };
  }

  test('rejette une soumission sans aucun bénéficiaire effectif', async () => {
    await expect(
      kycService.submitBusinessKyc('user-1', makeBusinessPayload({ ubos: [] }))
    ).rejects.toThrow(/bénéficiaire effectif/);

    expect(mockPrisma.businessProfile.upsert).not.toHaveBeenCalled();
  });

  test('filtre le nom de l\'entreprise, le représentant légal, ET chaque UBO', async () => {
    await kycService.submitBusinessKyc('user-1', makeBusinessPayload());

    expect(mockScreenNames).toHaveBeenCalledWith(['École Sainte Marie', 'Aminata Diallo', 'Fatoumata Bah']);
    expect(mockScreenName).toHaveBeenCalledWith('Fatoumata Bah');
  });

  test('crée les UBO via une écriture imbriquée sur le profil Business, avec leur propre résultat de filtrage', async () => {
    mockScreenName.mockResolvedValue({ hit: false, matches: [] });

    await kycService.submitBusinessKyc('user-1', makeBusinessPayload());

    const call = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(call.create.ubos.create).toHaveLength(1);
    expect(call.create.ubos.create[0]).toMatchObject({
      fullName: 'Fatoumata Bah',
      ownershipPercentage: 60,
      sanctionsHit: false,
    });
  });

  test('une resoumission remplace intégralement la liste des UBO précédente (deleteMany + create)', async () => {
    await kycService.submitBusinessKyc('user-1', makeBusinessPayload());

    const call = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(call.update.ubos.deleteMany).toEqual({});
    expect(call.update.ubos.create).toHaveLength(1);
  });

  test('un UBO seul peut déclencher le hit sanctions même si l\'entreprise et le représentant sont propres', async () => {
    mockScreenNames.mockResolvedValue({ hit: true, matches: [{ entityId: 'e-ubo', score: 0.02 }] });

    await kycService.submitBusinessKyc('user-1', makeBusinessPayload());

    const call = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(call.create.sanctionsHit).toBe(true);
  });

  test('confirme la réception du dossier Business (avant même la revue)', async () => {
    await kycService.submitBusinessKyc('user-1', makeBusinessPayload());

    expect(mockNotifyUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ type: 'KYB_SUBMITTED' }));
  });
});

describe('submitMerchantKyc - palier allégé sans registre légal', () => {
  const merchantPayload = { businessName: 'Restaurant Chez Aïssatou', category: 'Commerces', location: 'Madina' };

  test('exige une identité déjà vérifiée (KYC Tier 2)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_1' } });

    await expect(kycService.submitMerchantKyc('user-1', merchantPayload)).rejects.toThrow(/palier 2/);
    expect(mockPrisma.businessProfile.upsert).not.toHaveBeenCalled();
  });

  test('rejette un compte déjà Entreprise', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'BUSINESS', kycProfile: { tier: 'TIER_2' } });

    await expect(kycService.submitMerchantKyc('user-1', merchantPayload)).rejects.toThrow(/déjà un compte Entreprise/);
  });

  test('approuve automatiquement sans correspondance sur la liste de vigilance', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' }, fullName: 'Aïssatou Camara' });
    mockScreenNames.mockResolvedValue({ hit: false, matches: [] });

    const result = await kycService.submitMerchantKyc('user-1', merchantPayload);

    expect(result.reviewStatus).toBe('APPROVED');
    const userUpdateCall = mockPrisma.user.update.mock.calls[0][0];
    expect(userUpdateCall.data.accountType).toBe('MERCHANT');
    const profileCall = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(profileCall.create.reviewStatus).toBe('APPROVED');
    expect(mockNotifyUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ title: 'Compte Marchand activé ✓' }));
  });

  test('bascule en revue manuelle si le nom déclaré ou celui du titulaire matche la liste de vigilance', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' }, fullName: 'Jean Test Sanctionné' });
    mockScreenNames.mockResolvedValue({ hit: true, matches: [{ entityId: 'e1', score: 0.03 }] });

    const result = await kycService.submitMerchantKyc('user-1', merchantPayload);

    expect(result.reviewStatus).toBe('PENDING');
    const profileCall = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(profileCall.create.reviewStatus).toBe('PENDING');
    const auditCalls = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).toContain('SANCTIONS_SCREENING_HIT');
  });

  test('ne demande ni RCCM, ni NIF, ni représentant légal, ni UBO', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' }, fullName: 'Aïssatou Camara' });

    await kycService.submitMerchantKyc('user-1', merchantPayload);

    const profileCall = mockPrisma.businessProfile.upsert.mock.calls[0][0];
    expect(profileCall.create.rccmNumber).toBeUndefined();
    expect(profileCall.create.ubos).toBeUndefined();
  });
});

describe('reviewTier2 - notification du résultat (auparavant totalement silencieux)', () => {
  test('rejette si le dossier KYC est introuvable', async () => {
    mockPrisma.kycProfile.findUnique.mockResolvedValue(null);
    await expect(kycService.reviewTier2('user-1', 'admin-1', { approved: true })).rejects.toThrow('introuvable');
  });

  test('notifie l\'utilisateur avec un message positif en cas d\'approbation', async () => {
    mockPrisma.kycProfile.findUnique.mockResolvedValue({ tier: 'TIER_1' });
    mockPrisma.kycProfile.update.mockResolvedValue({});

    await kycService.reviewTier2('user-1', 'admin-1', { approved: true });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: expect.stringContaining('vérifiée') }),
      expect.any(String)
    );
  });

  test('notifie l\'utilisateur avec le motif exact en cas de rejet', async () => {
    mockPrisma.kycProfile.findUnique.mockResolvedValue({ tier: 'TIER_1' });
    mockPrisma.kycProfile.update.mockResolvedValue({});

    await kycService.reviewTier2('user-1', 'admin-1', { approved: false, rejectionReason: 'Photo illisible' });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ body: 'Photo illisible' }),
      expect.stringContaining('Photo illisible')
    );
  });
});

describe('reviewBusinessKyc - notification du résultat', () => {
  test('rejette si le dossier Business est introuvable', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue(null);
    await expect(kycService.reviewBusinessKyc('user-1', 'admin-1', { approved: true })).rejects.toThrow('introuvable');
  });

  test('notifie l\'entreprise en cas d\'approbation', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ businessName: 'École Test' });
    mockPrisma.businessProfile.update.mockResolvedValue({});

    await kycService.reviewBusinessKyc('user-1', 'admin-1', { approved: true });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: expect.stringContaining('validé') }),
      expect.any(String)
    );
  });
});

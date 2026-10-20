const mockPrisma = {
  user: { findUnique: jest.fn() },
  paymentLink: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockPayBusiness = jest.fn();
const mockPayBusinessGuest = jest.fn();
jest.mock('../../src/modules/payments/payments.service', () => ({
  payBusiness: (...args) => mockPayBusiness(...args),
  payBusinessGuest: (...args) => mockPayBusinessGuest(...args),
}));

const mockListFieldsForPayer = jest.fn();
jest.mock('../../src/modules/payments/businessPaymentFields.service', () => ({
  listFieldsForPayer: (...args) => mockListFieldsForPayer(...args),
}));

const mockCollect = jest.fn();
jest.mock('../../src/modules/externalPayments/externalPayments.service', () => ({
  EXTERNAL_PAYMENT_METHODS: ['orange_money', 'mtn_momo', 'card'],
  collect: (...args) => mockCollect(...args),
}));

const paymentLinksService = require('../../src/modules/paymentLinks/paymentLinks.service');

function makeApprovedBusinessUser(overrides = {}) {
  return {
    id: 'biz-1',
    accountType: 'BUSINESS',
    businessProfile: { id: 'bp-1', businessName: 'Boutique Aïcha', reviewStatus: 'APPROVED', ...overrides },
  };
}

function makeLink(overrides = {}) {
  return {
    id: 'link-1',
    code: 'abc123XYZ',
    businessProfileId: 'bp-1',
    label: 'Robe wax - Taille M',
    amount: 150000,
    active: true,
    expiresAt: null,
    paymentCount: 0,
    businessProfile: { userId: 'biz-1', businessName: 'Boutique Aïcha' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListFieldsForPayer.mockResolvedValue([]);
});

describe('createPaymentLink', () => {
  test('refuse la création pour un compte non-Business', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', accountType: 'INDIVIDUAL' });

    await expect(
      paymentLinksService.createPaymentLink('u1', { label: 'Test' })
    ).rejects.toThrow('Seul un compte Business');
  });

  test('refuse la création si le KYB n\'est pas encore approuvé', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      makeApprovedBusinessUser({ reviewStatus: 'PENDING' })
    );

    await expect(
      paymentLinksService.createPaymentLink('biz-1', { label: 'Test' })
    ).rejects.toThrow(/pas encore validé/);
  });

  test('crée le lien avec un code généré pour une entreprise approuvée', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null); // code jamais déjà pris
    mockPrisma.paymentLink.create.mockResolvedValue(makeLink());

    await paymentLinksService.createPaymentLink('biz-1', { label: 'Robe wax - Taille M', amount: 150000 });

    const createCall = mockPrisma.paymentLink.create.mock.calls[0][0];
    expect(createCall.data.businessProfileId).toBe('bp-1');
    expect(createCall.data.label).toBe('Robe wax - Taille M');
    expect(createCall.data.amount).toBe(150000);
    expect(createCall.data.code).toEqual(expect.any(String));
    expect(createCall.data.code.length).toBeGreaterThan(0);
  });

  test('impose toujours une expiration à 48h, jamais choisie par le marchand', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null);
    mockPrisma.paymentLink.create.mockResolvedValue(makeLink());

    const before = Date.now();
    await paymentLinksService.createPaymentLink('biz-1', { label: 'Robe wax', amount: 150000 });
    const after = Date.now();

    const createCall = mockPrisma.paymentLink.create.mock.calls[0][0];
    const expiresAtMs = createCall.data.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + paymentLinksService.LINK_LIFETIME_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + paymentLinksService.LINK_LIFETIME_MS + 1000);
  });

  test('un compte MERCHANT approuvé peut aussi créer un lien de paiement', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'biz-1',
      accountType: 'MERCHANT',
      businessProfile: { id: 'bp-1', businessName: 'Restaurant Chez Aïssatou', reviewStatus: 'APPROVED' },
    });
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null);
    mockPrisma.paymentLink.create.mockResolvedValue(makeLink());

    await expect(
      paymentLinksService.createPaymentLink('biz-1', { label: 'Plat du jour' })
    ).resolves.toBeDefined();
  });
});

describe('toggleActive - propriété vérifiée', () => {
  test('rejette avec le même message qu\'un lien inexistant si le lien appartient à une autre entreprise', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ businessProfileId: 'bp-autre-entreprise' }));

    await expect(
      paymentLinksService.toggleActive('biz-1', 'link-1', false)
    ).rejects.toThrow('introuvable');
    expect(mockPrisma.paymentLink.update).not.toHaveBeenCalled();
  });

  test('autorise la désactivation par le propriétaire réel', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    mockPrisma.paymentLink.update.mockResolvedValue(makeLink({ active: false }));

    await paymentLinksService.toggleActive('biz-1', 'link-1', false);

    expect(mockPrisma.paymentLink.update).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { active: false },
    });
  });
});

describe('reactivate - propriété vérifiée et fenêtre de 48h', () => {
  test('rejette avec le même message qu\'un lien inexistant si le lien appartient à une autre entreprise', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ businessProfileId: 'bp-autre-entreprise' }));

    await expect(
      paymentLinksService.reactivate('biz-1', 'link-1')
    ).rejects.toThrow('introuvable');
    expect(mockPrisma.paymentLink.update).not.toHaveBeenCalled();
  });

  test('réactive un lien expiré avec une nouvelle fenêtre de 48h, jamais plus', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeApprovedBusinessUser());
    mockPrisma.paymentLink.findUnique.mockResolvedValue(
      makeLink({ active: false, expiresAt: new Date(Date.now() - 60000) })
    );
    mockPrisma.paymentLink.update.mockResolvedValue(makeLink({ active: true }));

    const before = Date.now();
    await paymentLinksService.reactivate('biz-1', 'link-1');
    const after = Date.now();

    const updateCall = mockPrisma.paymentLink.update.mock.calls[0][0];
    expect(updateCall.data.active).toBe(true);
    const expiresAtMs = updateCall.data.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + paymentLinksService.LINK_LIFETIME_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + paymentLinksService.LINK_LIFETIME_MS + 1000);
  });
});

describe('getPublicLinkInfo', () => {
  test('lève une erreur pour un code inexistant', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null);
    await expect(paymentLinksService.getPublicLinkInfo('nope')).rejects.toThrow('introuvable');
  });

  test('ne révèle jamais l\'id interne du lien', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    const info = await paymentLinksService.getPublicLinkInfo('abc123XYZ');
    expect(info).not.toHaveProperty('id');
  });

  test('signale un lien désactivé comme INACTIVE, même avant expiration', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ active: false }));
    const info = await paymentLinksService.getPublicLinkInfo('abc123XYZ');
    expect(info.status).toBe('INACTIVE');
  });

  test('signale un lien expiré comme EXPIRED', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(
      makeLink({ expiresAt: new Date(Date.now() - 60000) })
    );
    const info = await paymentLinksService.getPublicLinkInfo('abc123XYZ');
    expect(info.status).toBe('EXPIRED');
  });

  test('amount vaut null pour un lien historique créé avant l\'obligation de montant', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ amount: null }));
    const info = await paymentLinksService.getPublicLinkInfo('abc123XYZ');
    expect(info.amount).toBeNull();
  });

  test("inclut les champs personnalisés de l'institution, pour affichage avant paiement", async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    mockListFieldsForPayer.mockResolvedValue([
      { id: 'f1', label: 'Nom de l\'élève', fieldKey: 'nom_de_leleve', required: true },
    ]);

    const info = await paymentLinksService.getPublicLinkInfo('abc123XYZ');

    expect(mockListFieldsForPayer).toHaveBeenCalledWith('biz-1');
    expect(info.customFields).toEqual([
      { id: 'f1', label: "Nom de l'élève", fieldKey: 'nom_de_leleve', required: true },
    ]);
  });
});

describe('payViaLink', () => {
  test('rejette un lien inexistant', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null);
    await expect(
      paymentLinksService.payViaLink('payer-1', 'nope', { idempotencyKey: 'idem-1' })
    ).rejects.toThrow('introuvable');
  });

  test('rejette un lien désactivé', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ active: false }));
    await expect(
      paymentLinksService.payViaLink('payer-1', 'abc123XYZ', { idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/plus actif/);
    expect(mockPayBusiness).not.toHaveBeenCalled();
  });

  test('rejette un lien expiré', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(
      makeLink({ expiresAt: new Date(Date.now() - 60000) })
    );
    await expect(
      paymentLinksService.payViaLink('payer-1', 'abc123XYZ', { idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/expiré/);
  });

  test('utilise toujours le montant fixe du lien, jamais une valeur envoyée par le payeur', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ amount: 150000 }));
    mockPayBusiness.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 2250 });
    mockPrisma.paymentLink.update.mockResolvedValue({});

    await paymentLinksService.payViaLink('payer-1', 'abc123XYZ', { idempotencyKey: 'idem-1' });

    expect(mockPayBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 150000, payerUserId: 'payer-1' })
    );
  });

  test('rejette un lien historique sans montant (créé avant l\'obligation de montant)', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ amount: null }));

    await expect(
      paymentLinksService.payViaLink('payer-1', 'abc123XYZ', { idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/montant/);
    expect(mockPayBusiness).not.toHaveBeenCalled();
  });

  test("relaie les champs personnalisés fournis par le payeur à payBusiness", async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    mockPayBusiness.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 2250 });
    mockPrisma.paymentLink.update.mockResolvedValue({});

    await paymentLinksService.payViaLink('payer-1', 'abc123XYZ', {
      idempotencyKey: 'idem-1',
      customFields: { nom_de_leleve: 'Mariama Camara' },
    });

    expect(mockPayBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ customFields: { nom_de_leleve: 'Mariama Camara' } })
    );
  });

  test('incrémente le compteur de paiements après un paiement réussi', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    mockPayBusiness.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 2250 });
    mockPrisma.paymentLink.update.mockResolvedValue({});

    await paymentLinksService.payViaLink('payer-1', 'abc123XYZ', { idempotencyKey: 'idem-1' });

    expect(mockPrisma.paymentLink.update).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { paymentCount: { increment: 1 } },
    });
  });
});

describe('payViaLinkMobileMoney - paiement invité (sans compte FlexPay)', () => {
  test('rejette un lien inexistant', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(null);
    await expect(
      paymentLinksService.payViaLinkMobileMoney('nope', { phone: '+224620111111', provider: 'orange_money', idempotencyKey: 'idem-1' })
    ).rejects.toThrow('introuvable');
    expect(mockCollect).not.toHaveBeenCalled();
  });

  test('rejette un lien expiré avant même de tenter la collecte Mobile Money', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(
      makeLink({ expiresAt: new Date(Date.now() - 60000) })
    );
    await expect(
      paymentLinksService.payViaLinkMobileMoney('abc123XYZ', { phone: '+224620111111', provider: 'orange_money', idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/expiré/);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  test('rejette si la collecte Mobile Money échoue, sans jamais créditer le marchand', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink());
    mockCollect.mockResolvedValue({ status: 'FAILED' });

    await expect(
      paymentLinksService.payViaLinkMobileMoney('abc123XYZ', { phone: '+224620111111', provider: 'mtn_momo', idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/Mobile Money/);
    expect(mockPayBusinessGuest).not.toHaveBeenCalled();
  });

  test('crédite le marchand sans compte payeur après une collecte réussie', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ amount: 150000 }));
    mockCollect.mockResolvedValue({ status: 'COMPLETED', providerReference: 'MOCK-ORANGE-abc' });
    mockPayBusinessGuest.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 2250 });
    mockPrisma.paymentLink.update.mockResolvedValue({});

    const result = await paymentLinksService.payViaLinkMobileMoney('abc123XYZ', {
      phone: '+224620111111',
      provider: 'orange_money',
      idempotencyKey: 'idem-1',
    });

    expect(mockCollect).toHaveBeenCalledWith({ phone: '+224620111111', amount: 150000, provider: 'orange_money' });
    expect(mockPayBusinessGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessUserId: 'biz-1',
        amount: 150000,
        payerPhone: '+224620111111',
        metadata: expect.objectContaining({ mobileMoneyProvider: 'orange_money', providerReference: 'MOCK-ORANGE-abc' }),
      })
    );
    expect(result).toEqual({ payment: { id: 'tx-1' }, feeAmount: 2250, amountPaid: 150000 });
    expect(mockPrisma.paymentLink.update).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { paymentCount: { increment: 1 } },
    });
  });

  test('rejette un lien historique sans montant, sans tenter de collecte', async () => {
    mockPrisma.paymentLink.findUnique.mockResolvedValue(makeLink({ amount: null }));
    await expect(
      paymentLinksService.payViaLinkMobileMoney('abc123XYZ', { phone: '+224620111111', provider: 'orange_money', idempotencyKey: 'idem-1' })
    ).rejects.toThrow(/montant/);
    expect(mockCollect).not.toHaveBeenCalled();
  });
});

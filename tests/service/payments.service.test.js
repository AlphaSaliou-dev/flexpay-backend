const mockPrisma = {
  user: { findUnique: jest.fn() },
  transaction: { findUnique: jest.fn() },
  apiClient: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockGetOrCreateUserWallet = jest.fn();
const mockGetOrCreateSystemWallet = jest.fn();
const mockMoveFunds = jest.fn();
jest.mock('../../src/modules/wallet/wallet.service', () => ({
  getOrCreateUserWallet: (...args) => mockGetOrCreateUserWallet(...args),
  getOrCreateSystemWallet: (...args) => mockGetOrCreateSystemWallet(...args),
  moveFunds: (...args) => mockMoveFunds(...args),
}));

jest.mock('../../src/modules/wallet/limits.guard', () => ({ assertWithinLimits: jest.fn() }));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const mockAssertCustomFieldsComplete = jest.fn();
jest.mock('../../src/modules/payments/businessPaymentFields.service', () => ({
  assertCustomFieldsComplete: (...args) => mockAssertCustomFieldsComplete(...args),
}));

const { payBusiness, payBusinessGuest, regenerateApiKey } = require('../../src/modules/payments/payments.service');

function makeBusiness(overrides = {}) {
  return {
    id: 'biz-1',
    accountType: 'BUSINESS',
    fullName: null,
    phone: '+224620999999',
    businessProfile: { reviewStatus: 'APPROVED', businessName: 'Pharmacie Kaloum' },
    ...overrides,
  };
}

function makePayer(overrides = {}) {
  return { id: 'payer-1', fullName: 'Aïssatou Camara', phone: '+224620000000', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-x', balance: 1000000 });
  mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-fees', balance: 0 });
  mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
  mockPrisma.transaction.findUnique.mockResolvedValue(null);
  mockAssertCustomFieldsComplete.mockResolvedValue([]);
});

describe('payBusiness - notifications', () => {
  test('notifie le payeur (paiement envoyé) et le marchand (paiement reçu)', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeBusiness()) // lookup du compte Business
      .mockResolvedValueOnce(makePayer()); // lookup du payeur pour la notification

    await payBusiness({
      payerUserId: 'payer-1',
      businessUserId: 'biz-1',
      amount: 85000,
      idempotencyKey: 'pay-1',
      metadata: {},
    });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'payer-1',
      expect.objectContaining({ type: 'PAYMENT_SENT', body: expect.stringContaining('Pharmacie Kaloum') })
    );
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({ type: 'PAYMENT_RECEIVED', body: expect.stringContaining('Aïssatou Camara') }),
      expect.any(String)
    );
  });

  test('ne renotifie ni le payeur ni le marchand pour un paiement déjà traité (retry réseau)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness());
    mockPrisma.transaction.findUnique.mockResolvedValue({ id: 'tx-existante' });

    await payBusiness({
      payerUserId: 'payer-1',
      businessUserId: 'biz-1',
      amount: 85000,
      idempotencyKey: 'pay-1',
      metadata: {},
    });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

describe('payBusiness - éligibilité du destinataire', () => {
  test('accepte un compte MERCHANT (palier allégé) comme un compte BUSINESS', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeBusiness({ accountType: 'MERCHANT' }))
      .mockResolvedValueOnce(makePayer());

    await expect(payBusiness({
      payerUserId: 'payer-1',
      businessUserId: 'biz-1',
      amount: 5000,
      idempotencyKey: 'pay-2',
      metadata: {},
    })).resolves.toBeDefined();
  });

  test('rejette un compte INDIVIDUAL (ni Business ni Marchand)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness({ accountType: 'INDIVIDUAL' }));

    await expect(payBusiness({
      payerUserId: 'payer-1',
      businessUserId: 'biz-1',
      amount: 5000,
      idempotencyKey: 'pay-3',
      metadata: {},
    })).rejects.toThrow(/Business ou Marchand/);
  });
});

describe('payBusinessGuest - paiement invité par Mobile Money (sans compte FlexPay)', () => {
  test('crédite le marchand depuis le wallet système, sans notifier aucun payeur (il n\'en existe pas)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness());

    await payBusinessGuest({
      businessUserId: 'biz-1',
      amount: 15000,
      payerPhone: '+224620111111',
      idempotencyKey: 'guest-1',
      metadata: { channel: 'payment_link_mobile_money', mobileMoneyProvider: 'orange_money' },
    });

    expect(mockGetOrCreateSystemWallet).toHaveBeenCalledWith('EXTERNAL_MOBILE_MONEY');
    expect(mockMoveFunds).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 15000, type: 'MERCHANT_PAYMENT', initiatedByUserId: null })
    );
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({ type: 'PAYMENT_RECEIVED', body: expect.stringContaining('+224620111111') }),
      expect.any(String)
    );
  });

  test('rejette un compte INDIVIDUAL (ni Business ni Marchand)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness({ accountType: 'INDIVIDUAL' }));

    await expect(payBusinessGuest({
      businessUserId: 'biz-1',
      amount: 15000,
      payerPhone: '+224620111111',
      idempotencyKey: 'guest-2',
      metadata: {},
    })).rejects.toThrow(/Business ou Marchand/);
  });

  test('ne renotifie pas pour un paiement déjà traité (retry réseau)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness());
    mockPrisma.transaction.findUnique.mockResolvedValue({ id: 'tx-existante' });

    await payBusinessGuest({
      businessUserId: 'biz-1',
      amount: 15000,
      payerPhone: '+224620111111',
      idempotencyKey: 'guest-1',
      metadata: {},
    });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('rejette un champ obligatoire manquant même quand customFields est absent de la requête - contrairement à payBusiness, un payeur anonyme ne doit jamais pouvoir le contourner', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeBusiness());
    mockAssertCustomFieldsComplete.mockRejectedValue(new Error('Champ(s) requis manquant(s) : Nom'));

    await expect(payBusinessGuest({
      businessUserId: 'biz-1',
      amount: 15000,
      payerPhone: '+224620111111',
      idempotencyKey: 'guest-3',
      metadata: {},
    })).rejects.toThrow(/Nom/);

    expect(mockAssertCustomFieldsComplete).toHaveBeenCalledWith('biz-1', {});
    expect(mockMoveFunds).not.toHaveBeenCalled();
  });
});

describe('regenerateApiKey - seul recours si la clé brute est perdue (jamais stockée)', () => {
  test('rejette si la clé appartient à une autre entreprise', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'client-1', businessUserId: 'autre-entreprise', environment: 'TEST' });

    await expect(regenerateApiKey('biz-1', 'client-1')).rejects.toThrow('introuvable');
    expect(mockPrisma.apiClient.update).not.toHaveBeenCalled();
  });

  test('génère une nouvelle clé TEST et invalide l\'ancienne (nouveau hash en base)', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'client-1', businessUserId: 'biz-1', environment: 'TEST', apiKeyHash: 'ancien-hash' });
    mockPrisma.apiClient.update.mockResolvedValue({ id: 'client-1', environment: 'TEST' });

    const result = await regenerateApiKey('biz-1', 'client-1');

    expect(result.apiKey).toMatch(/^fp_test_/);
    const updateCall = mockPrisma.apiClient.update.mock.calls[0][0];
    expect(updateCall.data.apiKeyHash).not.toBe('ancien-hash');
    expect(updateCall.data.apiKeyPrefix).toMatch(/^fp_test_/);
  });

  test('génère une clé fp_live_ pour un client LIVE, jamais fp_test_', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'client-2', businessUserId: 'biz-1', environment: 'LIVE' });
    mockPrisma.apiClient.update.mockResolvedValue({ id: 'client-2', environment: 'LIVE' });

    const result = await regenerateApiKey('biz-1', 'client-2');

    expect(result.apiKey).toMatch(/^fp_live_/);
  });
});

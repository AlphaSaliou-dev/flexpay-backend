const mockPrisma = {
  apiPayout: { findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn() },
  businessProfile: { findUnique: jest.fn() },
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

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const mockDeliverWebhook = jest.fn();
jest.mock('../../src/modules/payments/webhook.service', () => ({
  deliverWebhook: (...args) => mockDeliverWebhook(...args),
}));

jest.mock('../../src/modules/payments/payments.service', () => ({
  PaymentError: class PaymentError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

const payoutService = require('../../src/modules/payments/apiPayout.service');

function makeApiClient(overrides = {}) {
  return { id: 'client-1', name: 'MarketConnect', businessUserId: 'biz-1', environment: 'LIVE', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.apiPayout.findUnique.mockResolvedValue(null); // pas déjà traité, par défaut
  // Par défaut, renvoie exactement les données passées à create() - assez
  // réaliste pour inspecter status/transactionId sans fixture manuelle ;
  // les tests qui ont besoin d'un id précis (assertions webhook) le
  // surchargent explicitement avec mockResolvedValueOnce.
  mockPrisma.apiPayout.create.mockImplementation((args) => Promise.resolve(args.data));
  mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-1', balance: 10_000_000 });
  mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-fees' });
  mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
  mockPrisma.businessProfile.findUnique.mockResolvedValue(null);
});

describe('createPayout - mode LIVE', () => {
  test('rejette un bénéficiaire introuvable ou inactif', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      payoutService.createPayout(makeApiClient(), {
        recipientPhone: '+224620000001', amount: 50000, idempotencyKey: 'payout-1',
      })
    ).rejects.toThrow(/introuvable/);
    expect(mockMoveFunds).not.toHaveBeenCalled();
  });

  test('rejette si le solde du partenaire ne couvre pas le montant + les frais', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-1', phone: '+224620000001', status: 'ACTIVE' });
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000 });

    await expect(
      payoutService.createPayout(makeApiClient(), {
        recipientPhone: '+224620000001', amount: 50000, idempotencyKey: 'payout-1',
      })
    ).rejects.toThrow(/Solde insuffisant/);
  });

  test('le bénéficiaire reçoit le montant plein, les frais sont débités séparément du partenaire', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-1', phone: '+224620000001', status: 'ACTIVE' });
    mockPrisma.apiPayout.create.mockResolvedValue({ id: 'payout-record-1' });

    await payoutService.createPayout(makeApiClient(), {
      recipientPhone: '+224620000001', amount: 50000, idempotencyKey: 'payout-1',
    });

    const transferCall = mockMoveFunds.mock.calls[0][0];
    const feeCall = mockMoveFunds.mock.calls[1][0];
    expect(transferCall.amount).toBe(50000);
    expect(transferCall.type).toBe('TRANSFER');
    expect(feeCall.amount).toBe(500); // 1% de 50000
    expect(feeCall.type).toBe('FEE');
    expect(feeCall.toWalletId).not.toBe(transferCall.toWalletId);
  });

  test('notifie le bénéficiaire et déclenche un webhook payout.completed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-1', phone: '+224620000001', status: 'ACTIVE' });
    mockPrisma.apiPayout.create.mockResolvedValue({ id: 'payout-record-1' });

    await payoutService.createPayout(makeApiClient(), {
      recipientPhone: '+224620000001', amount: 50000, idempotencyKey: 'payout-1',
    });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'recipient-1',
      expect.objectContaining({ type: 'TRANSFER_RECEIVED' }),
      expect.any(String)
    );
    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'client-1' }),
      'payout.completed',
      expect.objectContaining({ payoutId: 'payout-record-1' })
    );
  });

  test('idempotence : une clé déjà traitée renvoie le versement existant sans rejouer le mouvement de fonds', async () => {
    mockPrisma.apiPayout.findUnique.mockResolvedValue({ id: 'payout-existant', status: 'COMPLETED' });

    const result = await payoutService.createPayout(makeApiClient(), {
      recipientPhone: '+224620000001', amount: 50000, idempotencyKey: 'payout-1',
    });

    expect(result).toEqual({ id: 'payout-existant', status: 'COMPLETED' });
    expect(mockMoveFunds).not.toHaveBeenCalled();
  });
});

describe('createPayout - mode TEST', () => {
  test('ne déplace jamais de vrai argent et n\'exige aucun utilisateur réel', async () => {
    await payoutService.createPayout(makeApiClient({ environment: 'TEST' }), {
      recipientPhone: '+224699999999', amount: 999999, idempotencyKey: 'payout-test-1',
    });

    expect(mockMoveFunds).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('complète immédiatement (pas d\'étape d\'approbation à simuler, contrairement à un PaymentIntent)', async () => {
    const result = await payoutService.createPayout(makeApiClient({ environment: 'TEST' }), {
      recipientPhone: '+224699999999', amount: 10000, idempotencyKey: 'payout-test-2',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.transactionId).toMatch(/^test_tx_/);
  });

  test('forceOutcome=FAILED simule un échec pour tester son propre code d\'erreur', async () => {
    const result = await payoutService.createPayout(makeApiClient({ environment: 'TEST' }), {
      recipientPhone: '+224699999999', amount: 10000, idempotencyKey: 'payout-test-3', forceOutcome: 'FAILED',
    });

    expect(result.status).toBe('FAILED');
    expect(result.transactionId).toBeNull();
    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'payout.failed',
      expect.objectContaining({ test: true })
    );
  });
});

describe('getPayoutStatus', () => {
  test('rejette avec le même message qu\'un id inexistant si le versement appartient à un autre partenaire', async () => {
    mockPrisma.apiPayout.findUnique.mockResolvedValue({ id: 'p1', apiClientId: 'autre-partenaire' });

    await expect(payoutService.getPayoutStatus(makeApiClient({ id: 'client-1' }), 'p1')).rejects.toThrow('introuvable');
  });
});

describe('listPayoutsForApiClient', () => {
  test('ne renvoie que les versements de ce partenaire', async () => {
    mockPrisma.apiPayout.findMany.mockResolvedValue([]);
    mockPrisma.apiPayout.count.mockResolvedValue(0);

    await payoutService.listPayoutsForApiClient(makeApiClient({ id: 'client-1' }));

    expect(mockPrisma.apiPayout.findMany.mock.calls[0][0].where.apiClientId).toBe('client-1');
  });
});

const mockPrisma = {
  paymentIntent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn() },
  apiClient: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockAssertWithinLimits = jest.fn();
jest.mock('../../src/modules/wallet/limits.guard', () => ({
  assertWithinLimits: (...args) => mockAssertWithinLimits(...args),
}));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const mockPayBusiness = jest.fn();
const mockPayBusinessGuest = jest.fn();
jest.mock('../../src/modules/payments/payments.service', () => ({
  payBusiness: (...args) => mockPayBusiness(...args),
  payBusinessGuest: (...args) => mockPayBusinessGuest(...args),
  PaymentError: class PaymentError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

const mockCollect = jest.fn();
jest.mock('../../src/modules/externalPayments/externalPayments.service', () => ({
  EXTERNAL_PAYMENT_METHODS: ['orange_money', 'mtn_momo', 'card'],
  collect: (...args) => mockCollect(...args),
}));

const intentService = require('../../src/modules/payments/paymentIntent.service');

function makeApiClient(overrides = {}) {
  return { id: 'client-1', name: 'MarketConnect', businessUserId: 'biz-1', environment: 'LIVE', enabledExternalMethods: ['orange_money', 'mtn_momo'], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createIntent - mode LIVE', () => {
  test('accepte un numéro sans compte FlexPay (payerUserId null, sans notification) - résolution attendue via collectIntentExternally', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-guest-1' });

    await intentService.createIntent(makeApiClient(), { payerPhone: '+224699999999', amount: 1000, idempotencyKey: 'k1' });

    const call = mockPrisma.paymentIntent.create.mock.calls[0][0].data;
    expect(call.payerUserId).toBeNull();
    expect(call.payerPhone).toBe('+224699999999');
    expect(mockAssertWithinLimits).not.toHaveBeenCalled();
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('ne vérifie pas les plafonds pour un numéro sans compte FlexPay inactif', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-x', phone: '+224699999999', status: 'PENDING_VERIFICATION' });
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-guest-2' });

    await intentService.createIntent(makeApiClient(), { payerPhone: '+224699999999', amount: 1000, idempotencyKey: 'k1b' });

    const call = mockPrisma.paymentIntent.create.mock.calls[0][0].data;
    expect(call.payerUserId).toBeNull();
    expect(mockAssertWithinLimits).not.toHaveBeenCalled();
  });

  test('vérifie les plafonds réels du payeur avant de créer l\'intention', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '+224620000000', status: 'ACTIVE' });
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-1' });

    await intentService.createIntent(makeApiClient(), { payerPhone: '+224620000000', amount: 50000, idempotencyKey: 'k2' });

    expect(mockAssertWithinLimits).toHaveBeenCalledWith('user-1', 50000);
  });

  test('notifie le payeur réel (push + repli SMS) via notifyUser', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '+224620000000', status: 'ACTIVE' });
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-1' });

    await intentService.createIntent(makeApiClient(), { payerPhone: '+224620000000', amount: 50000, idempotencyKey: 'k3' });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: expect.any(String), body: expect.stringContaining('MarketConnect') }),
      expect.stringContaining('MarketConnect')
    );
  });

  test('crée l\'intention avec environment LIVE et un vrai payerUserId', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', phone: '+224620000000', status: 'ACTIVE' });
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-1' });

    await intentService.createIntent(makeApiClient(), { payerPhone: '+224620000000', amount: 50000, idempotencyKey: 'k4' });

    const call = mockPrisma.paymentIntent.create.mock.calls[0][0].data;
    expect(call.environment).toBe('LIVE');
    expect(call.payerUserId).toBe('user-1');
  });
});

describe('createIntent - mode TEST (le coeur du bac à sable)', () => {
  test('accepte n\'importe quel numéro, même sans utilisateur réel correspondant', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-test-1' });

    await intentService.createIntent(makeApiClient({ environment: 'TEST' }), {
      payerPhone: '+224600000000', // numéro fictif, n'existe dans aucune vraie base utilisateur
      amount: 999999999,
      idempotencyKey: 'k5',
    });

    // Le point le plus important : aucune vérification d'utilisateur réel
    // n'a été tentée en mode test.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('ne vérifie JAMAIS les plafonds réels en mode test', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-test-2' });

    await intentService.createIntent(makeApiClient({ environment: 'TEST' }), {
      payerPhone: '+224600000000',
      amount: 999999999,
      idempotencyKey: 'k6',
    });

    expect(mockAssertWithinLimits).not.toHaveBeenCalled();
  });

  test('n\'envoie JAMAIS de notification en mode test (personne de réel à notifier)', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-test-3' });

    await intentService.createIntent(makeApiClient({ environment: 'TEST' }), {
      payerPhone: '+224600000000',
      amount: 1000,
      idempotencyKey: 'k7',
    });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('crée l\'intention avec environment TEST et payerUserId null (aucun lien vers un vrai compte)', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(null);
    mockPrisma.paymentIntent.create.mockResolvedValue({ id: 'intent-test-4' });

    await intentService.createIntent(makeApiClient({ environment: 'TEST' }), {
      payerPhone: '+224600000000',
      amount: 1000,
      idempotencyKey: 'k8',
    });

    const call = mockPrisma.paymentIntent.create.mock.calls[0][0].data;
    expect(call.environment).toBe('TEST');
    expect(call.payerUserId).toBeNull();
    expect(call.payerPhone).toBe('+224600000000');
  });
});

describe('testResolveIntent - simulation sans aucun mouvement d\'argent réel', () => {
  test('rejette si l\'intention n\'appartient pas à ce partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({ id: 'i1', apiClientId: 'autre-client', environment: 'TEST', status: 'PENDING_APPROVAL' });

    await expect(intentService.testResolveIntent(makeApiClient(), 'i1', 'APPROVED')).rejects.toThrow(/introuvable/);
  });

  test('rejette catégoriquement sur une intention LIVE - jamais utilisable pour de l\'argent réel', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i2', apiClientId: 'client-1', environment: 'LIVE', status: 'PENDING_APPROVAL',
    });

    await expect(intentService.testResolveIntent(makeApiClient(), 'i2', 'APPROVED')).rejects.toThrow(/mode test/);

    // Aucune écriture ne doit avoir eu lieu - le refus est total, pas une simple erreur cosmétique.
    expect(mockPrisma.paymentIntent.update).not.toHaveBeenCalled();
  });

  test('rejette si l\'intention n\'est plus en attente (déjà résolue)', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i3', apiClientId: 'client-1', environment: 'TEST', status: 'APPROVED',
    });

    await expect(intentService.testResolveIntent(makeApiClient(), 'i3', 'APPROVED')).rejects.toThrow(/plus en attente/);
  });

  test('APPROVED génère un transactionId préfixé "test_" - jamais confondable avec une vraie transaction', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i4', apiClientId: 'client-1', environment: 'TEST', status: 'PENDING_APPROVAL',
    });
    mockPrisma.paymentIntent.update.mockResolvedValue({ id: 'i4', status: 'APPROVED' });

    await intentService.testResolveIntent(makeApiClient(), 'i4', 'APPROVED');

    const call = mockPrisma.paymentIntent.update.mock.calls[0][0].data;
    expect(call.status).toBe('APPROVED');
    expect(call.transactionId).toMatch(/^test_tx_/);

    // Aucun appel à payBusiness (le vrai moteur de mouvement d'argent) -
    // c'est la garantie centrale de tout ce module.
    expect(mockPayBusiness).not.toHaveBeenCalled();
  });

  test('REJECTED ne génère aucun transactionId', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i5', apiClientId: 'client-1', environment: 'TEST', status: 'PENDING_APPROVAL',
    });
    mockPrisma.paymentIntent.update.mockResolvedValue({ id: 'i5', status: 'REJECTED' });

    await intentService.testResolveIntent(makeApiClient(), 'i5', 'REJECTED');

    const call = mockPrisma.paymentIntent.update.mock.calls[0][0].data;
    expect(call.status).toBe('REJECTED');
    expect(call.transactionId).toBeNull();
  });
});

describe('listPendingIntentsForUser - les intentions TEST ne doivent jamais y apparaître', () => {
  test('ne remonte que les intentions liées à un vrai payerUserId (jamais TEST, qui a payerUserId=null)', async () => {
    mockPrisma.paymentIntent.updateMany.mockResolvedValue({});
    mockPrisma.paymentIntent.findMany.mockResolvedValue([]);

    await intentService.listPendingIntentsForUser('user-1');

    // La requête elle-même filtre par payerUserId réel - une intention TEST
    // (payerUserId: null) ne peut structurellement jamais correspondre.
    expect(mockPrisma.paymentIntent.findMany.mock.calls[0][0].where.payerUserId).toBe('user-1');
  });
});

describe('listIntentsForApiClient - réconciliation côté partenaire', () => {
  test('ne renvoie que les intentions de CE partenaire, jamais celles d\'un autre', async () => {
    mockPrisma.paymentIntent.findMany.mockResolvedValue([]);
    mockPrisma.paymentIntent.count.mockResolvedValue(0);

    await intentService.listIntentsForApiClient(makeApiClient({ id: 'client-1' }));

    expect(mockPrisma.paymentIntent.findMany.mock.calls[0][0].where.apiClientId).toBe('client-1');
    expect(mockPrisma.paymentIntent.count.mock.calls[0][0].where.apiClientId).toBe('client-1');
  });

  test('filtre par statut quand fourni', async () => {
    mockPrisma.paymentIntent.findMany.mockResolvedValue([]);
    mockPrisma.paymentIntent.count.mockResolvedValue(0);

    await intentService.listIntentsForApiClient(makeApiClient(), { status: 'APPROVED' });

    expect(mockPrisma.paymentIntent.findMany.mock.calls[0][0].where.status).toBe('APPROVED');
  });

  test('pagine le résultat (page/pageSize/total)', async () => {
    mockPrisma.paymentIntent.findMany.mockResolvedValue([{ id: 'i1' }]);
    mockPrisma.paymentIntent.count.mockResolvedValue(1);

    const result = await intentService.listIntentsForApiClient(makeApiClient());

    expect(result.items).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });
});

describe('cancelIntent - annulation côté partenaire (distincte du rejet par le payeur)', () => {
  test('rejette avec le même message qu\'une intention inexistante si elle appartient à un autre partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({ id: 'i1', apiClientId: 'autre-partenaire', status: 'PENDING_APPROVAL' });

    await expect(intentService.cancelIntent(makeApiClient({ id: 'client-1' }), 'i1')).rejects.toThrow('introuvable');
    expect(mockPrisma.paymentIntent.update).not.toHaveBeenCalled();
  });

  test('rejette si l\'intention n\'est plus en attente (déjà approuvée, rejetée ou expirée)', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({ id: 'i1', apiClientId: 'client-1', status: 'APPROVED' });

    await expect(intentService.cancelIntent(makeApiClient({ id: 'client-1' }), 'i1')).rejects.toThrow(/plus en attente/);
  });

  test('annule une intention encore en attente, appartenant bien à ce partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({ id: 'i1', apiClientId: 'client-1', status: 'PENDING_APPROVAL' });
    mockPrisma.paymentIntent.update.mockResolvedValue({ id: 'i1', status: 'CANCELLED' });

    await intentService.cancelIntent(makeApiClient({ id: 'client-1' }), 'i1');

    expect(mockPrisma.paymentIntent.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'CANCELLED', resolvedAt: expect.any(Date) },
    });
  });
});

describe('collectIntentExternally - client final sans compte FlexPay (Orange Money/MTN/carte)', () => {
  function makeIntent(overrides = {}) {
    return {
      id: 'intent-1',
      apiClientId: 'client-1',
      environment: 'LIVE',
      status: 'PENDING_APPROVAL',
      amount: 25000,
      reference: 'Commande #42',
      expiresAt: new Date(Date.now() + 60000),
      ...overrides,
    };
  }

  test('rejette si le moyen demandé n\'est pas activé par ce partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent());

    await expect(
      intentService.collectIntentExternally(makeApiClient({ enabledExternalMethods: ['orange_money'] }), 'intent-1', {
        phone: '+224620000000',
        provider: 'card',
      })
    ).rejects.toThrow(/n'a pas activé/);
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockPayBusinessGuest).not.toHaveBeenCalled();
  });

  test('rejette une intention qui n\'appartient pas à ce partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent({ apiClientId: 'autre-partenaire' }));

    await expect(
      intentService.collectIntentExternally(makeApiClient(), 'intent-1', { phone: '+224620000000', provider: 'orange_money' })
    ).rejects.toThrow(/introuvable/);
  });

  test('rejette une intention déjà résolue', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent({ status: 'APPROVED' }));

    await expect(
      intentService.collectIntentExternally(makeApiClient(), 'intent-1', { phone: '+224620000000', provider: 'orange_money' })
    ).rejects.toThrow(/plus en attente/);
  });

  test('mode TEST : aucun mouvement de fonds réel, même avec un moyen externe activé', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent({ environment: 'TEST' }));
    mockPrisma.paymentIntent.update.mockResolvedValue({ id: 'intent-1', status: 'APPROVED' });

    const result = await intentService.collectIntentExternally(makeApiClient({ environment: 'TEST' }), 'intent-1', {
      phone: '+224620000000',
      provider: 'orange_money',
    });

    expect(result.transactionId).toMatch(/^test_tx_/);
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockPayBusinessGuest).not.toHaveBeenCalled();
  });

  test('mode LIVE : collecte le paiement externe puis crédite le wallet du partenaire via payBusinessGuest', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent());
    mockPrisma.paymentIntent.update.mockResolvedValue({ id: 'intent-1', status: 'APPROVED' });
    mockCollect.mockResolvedValue({ status: 'COMPLETED', providerReference: 'MOCK-ORANGE-xyz' });
    mockPayBusinessGuest.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 375 });

    const result = await intentService.collectIntentExternally(makeApiClient(), 'intent-1', {
      phone: '+224620000000',
      provider: 'orange_money',
    });

    expect(mockCollect).toHaveBeenCalledWith({ phone: '+224620000000', amount: 25000, provider: 'orange_money' });
    expect(mockPayBusinessGuest).toHaveBeenCalledWith(
      expect.objectContaining({ businessUserId: 'biz-1', amount: 25000, payerPhone: '+224620000000' })
    );
    expect(result).toEqual({ transactionId: 'tx-1', feeAmount: 375, intent: { id: 'intent-1', status: 'APPROVED' } });
  });

  test('rejette si la collecte externe échoue, sans jamais créditer le partenaire', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue(makeIntent());
    mockCollect.mockResolvedValue({ status: 'FAILED' });

    await expect(
      intentService.collectIntentExternally(makeApiClient(), 'intent-1', { phone: '+224620000000', provider: 'mtn_momo' })
    ).rejects.toThrow(/échoué/);
    expect(mockPayBusinessGuest).not.toHaveBeenCalled();
  });
});

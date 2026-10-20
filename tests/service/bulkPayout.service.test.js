const mockPrisma = {
  bulkPayout: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  bulkPayoutItem: { update: jest.fn() },
  user: { findUnique: jest.fn() },
  wallet: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const mockGetOrCreateUserWallet = jest.fn();
const mockGetOrCreateSystemWallet = jest.fn();
const mockMoveFunds = jest.fn();
jest.mock('../../src/modules/wallet/wallet.service', () => ({
  getOrCreateUserWallet: (...args) => mockGetOrCreateUserWallet(...args),
  getOrCreateSystemWallet: (...args) => mockGetOrCreateSystemWallet(...args),
  moveFunds: (...args) => mockMoveFunds(...args),
}));

const mockAssertWithinLimits = jest.fn();
jest.mock('../../src/modules/wallet/limits.guard', () => ({
  assertWithinLimits: (...args) => mockAssertWithinLimits(...args),
  LimitExceededError: class LimitExceededError extends Error {},
}));

const mockExternalPayout = jest.fn();
jest.mock('../../src/modules/externalPayments/externalPayments.service', () => ({
  EXTERNAL_PAYMENT_METHODS: ['orange_money', 'mtn_momo', 'card'],
  payout: (...args) => mockExternalPayout(...args),
}));

const bulkPayoutService = require('../../src/modules/bulkPayout/bulkPayout.service');

function makeBulkPayout(overrides = {}) {
  return {
    id: 'bp-1',
    initiatedByUserId: 'biz-owner',
    idempotencyKey: 'batch-key-1',
    successCount: 2,
    failedCount: 1,
    items: [
      { id: 'item-1', recipientPhone: '+224620000001', amount: 100000, status: 'SUCCESS' },
      { id: 'item-2', recipientPhone: '+224620000002', amount: 200000, status: 'SUCCESS' },
      { id: 'item-3', recipientPhone: '+224699999999', amount: 50000, status: 'FAILED', failureReason: "Ce numéro n'est pas inscrit ou n'est pas actif sur FlexPay" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-fees' });
});

describe('createBulkPayout - notification', () => {
  test('notifie l\'entreprise avec le décompte réussi/échoué à la fin du lot', async () => {
    mockPrisma.bulkPayout.findUnique
      .mockResolvedValueOnce(null) // pas déjà traité (garde d'idempotence)
      .mockResolvedValueOnce(makeBulkPayout({ successCount: 1, failedCount: 0, items: [{ id: 'item-1', status: 'SUCCESS' }] })); // getBulkPayoutSummary final
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'biz-owner', accountType: 'BUSINESS', businessProfile: {} }) // compte Business
      .mockResolvedValueOnce({ id: 'recipient-1', phone: '+224620000001', status: 'ACTIVE' }); // bénéficiaire
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 10_000_000 });
    mockPrisma.bulkPayout.create.mockResolvedValue({
      id: 'bp-new',
      idempotencyKey: 'batch-key-new',
      items: [{ id: 'item-1', recipientPhone: '+224620000001', amount: 100000, reference: null }],
    });
    mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224620000001', amount: 100000 }],
      reference: 'Salaires',
      idempotencyKey: 'batch-key-new',
    });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'biz-owner',
      expect.objectContaining({ type: 'BULK_PAYOUT_COMPLETED' })
    );
  });

  test('ne renotifie jamais un lot déjà traité (même idempotencyKey)', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout({ idempotencyKey: 'batch-existante' }));

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224620000001', amount: 100000 }],
      idempotencyKey: 'batch-existante',
    });

    expect(mockNotifyUser).not.toHaveBeenCalled();
    expect(mockPrisma.bulkPayout.create).not.toHaveBeenCalled();
  });
});

describe('getBulkPayoutSummaryForBusiness - correction de sécurité', () => {
  test('refuse l\'accès au lot d\'une AUTRE entreprise, avec le même message qu\'un id inexistant', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout({ initiatedByUserId: 'autre-entreprise' }));

    await expect(
      bulkPayoutService.getBulkPayoutSummaryForBusiness('biz-owner', 'bp-1')
    ).rejects.toThrow('Paiement en masse introuvable');
  });

  test('autorise l\'accès au propriétaire réel du lot', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());

    const result = await bulkPayoutService.getBulkPayoutSummaryForBusiness('biz-owner', 'bp-1');
    expect(result.id).toBe('bp-1');
  });
});

describe('retryFailedItems', () => {
  test('rejette si le lot appartient à une autre entreprise', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout({ initiatedByUserId: 'autre-entreprise' }));

    await expect(bulkPayoutService.retryFailedItems('biz-owner', 'bp-1')).rejects.toThrow('introuvable');
  });

  test('rejette s\'il n\'y a aucune ligne en échec à renvoyer', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(
      makeBulkPayout({ items: [{ id: 'item-1', status: 'SUCCESS', amount: 1000, recipientPhone: '+224620000001' }] })
    );

    await expect(bulkPayoutService.retryFailedItems('biz-owner', 'bp-1')).rejects.toThrow(/Aucune ligne en échec/);
  });

  test('ne rejoue QUE les lignes FAILED, jamais les lignes déjà SUCCESS (pas de double paiement)', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});
    mockPrisma.bulkPayout.findUnique.mockResolvedValueOnce(makeBulkPayout()).mockResolvedValueOnce(makeBulkPayout());

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    // Deux appels moveFunds pour item-3 (transfert + frais), jamais pour
    // item-1/item-2 déjà SUCCESS.
    expect(mockMoveFunds).toHaveBeenCalledTimes(2);
    expect(mockMoveFunds.mock.calls[0][0].idempotencyKey).toBe('batch-key-1:item:item-3');
    expect(mockMoveFunds.mock.calls[1][0].idempotencyKey).toBe('batch-key-1:item:item-3:fee');
    expect(mockMoveFunds.mock.calls[1][0].type).toBe('FEE');
  });

  test('le frais du paiement en masse est débité en plus du montant versé, jamais déduit du bénéficiaire', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    // item-3 = 50000 GNF, taux par défaut 1% -> 500 GNF de frais.
    const transferCall = mockMoveFunds.mock.calls[0][0];
    const feeCall = mockMoveFunds.mock.calls[1][0];
    expect(transferCall.amount).toBe(50000); // le bénéficiaire reçoit le montant plein
    expect(feeCall.amount).toBe(500);
    expect(feeCall.toWalletId).not.toBe(transferCall.toWalletId); // va vers FEES_COLLECTED, pas le bénéficiaire
  });

  test('une ligne renvoyée avec succès passe de FAILED à SUCCESS et efface le motif d\'échec', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    const updateCall = mockPrisma.bulkPayoutItem.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('SUCCESS');
    expect(updateCall.data.failureReason).toBeNull();
  });

  test('le statut final du lot passe à COMPLETED si tous les échecs sont résolus', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    const batchUpdateCall = mockPrisma.bulkPayout.update.mock.calls[0][0];
    expect(batchUpdateCall.data.status).toBe('COMPLETED');
    expect(batchUpdateCall.data.failedCount).toBe(0);
    expect(batchUpdateCall.data.successCount).toBe(3);
  });

  test('notifie l\'entreprise à la fin du renvoi', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'biz-owner',
      expect.objectContaining({ type: 'BULK_PAYOUT_COMPLETED' })
    );
  });

  test('une ligne qui échoue encore reste FAILED avec un nouveau motif, le lot reste PARTIALLY_FAILED', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue(null); // toujours pas inscrit
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    expect(mockMoveFunds).not.toHaveBeenCalled();
    const batchUpdateCall = mockPrisma.bulkPayout.update.mock.calls[0][0];
    expect(batchUpdateCall.data.status).toBe('PARTIALLY_FAILED');
    expect(batchUpdateCall.data.failedCount).toBe(1);
  });

  test('rejette si le solde ne couvre plus les lignes à renvoyer', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(makeBulkPayout());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000 }); // insuffisant pour 50000

    await expect(bulkPayoutService.retryFailedItems('biz-owner', 'bp-1')).rejects.toThrow(/Solde insuffisant/);
    expect(mockMoveFunds).not.toHaveBeenCalled();
  });
});

describe('retryFailedItems - sélection précise de lignes (itemIds)', () => {
  function twoFailedItems() {
    return makeBulkPayout({
      failedCount: 2,
      items: [
        { id: 'item-1', recipientPhone: '+224620000001', amount: 100000, status: 'SUCCESS' },
        { id: 'item-2', recipientPhone: '+224699999998', amount: 30000, status: 'FAILED', failureReason: 'x' },
        { id: 'item-3', recipientPhone: '+224699999999', amount: 50000, status: 'FAILED', failureReason: 'x' },
      ],
    });
  }

  test('ne relance que la ligne sélectionnée, laisse les autres échecs intacts', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(twoFailedItems());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1', { itemIds: ['item-3'] });

    // Un seul item touché (item-3) : 2 appels moveFunds (transfert + frais), jamais pour item-2.
    expect(mockMoveFunds).toHaveBeenCalledTimes(2);
    expect(mockMoveFunds.mock.calls[0][0].idempotencyKey).toBe('batch-key-1:item:item-3');
    expect(mockPrisma.bulkPayoutItem.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.bulkPayoutItem.update.mock.calls[0][0].where.id).toBe('item-3');

    // Le lot reste PARTIALLY_FAILED : item-2 toujours en échec, jamais retenté.
    const batchUpdateCall = mockPrisma.bulkPayout.update.mock.calls[0][0];
    expect(batchUpdateCall.data.status).toBe('PARTIALLY_FAILED');
    expect(batchUpdateCall.data.failedCount).toBe(1); // 2 échecs de départ - 1 résolu
  });

  test('le contrôle de solde ne porte que sur les lignes sélectionnées, pas tout le lot', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(twoFailedItems());
    // Couvre seulement item-3 (50000 + 1% de frais = 50500), pas les deux échecs ensemble (80000+).
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 51000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await expect(
      bulkPayoutService.retryFailedItems('biz-owner', 'bp-1', { itemIds: ['item-3'] })
    ).resolves.not.toThrow();
  });

  test('un id qui ne correspond à aucune ligne FAILED de ce lot est ignoré, pas une erreur', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(twoFailedItems());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    // 'item-1' est déjà SUCCESS, pas une ligne FAILED de ce lot.
    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1', { itemIds: ['item-3', 'item-1'] });

    expect(mockPrisma.bulkPayoutItem.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.bulkPayoutItem.update.mock.calls[0][0].where.id).toBe('item-3');
  });

  test('sans itemIds, le comportement historique est inchangé : tous les échecs sont relancés', async () => {
    mockPrisma.bulkPayout.findUnique.mockResolvedValue(twoFailedItems());
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 1000000 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'recipient-3', phone: '+224699999999', status: 'ACTIVE' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-retry-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.retryFailedItems('biz-owner', 'bp-1');

    expect(mockPrisma.bulkPayoutItem.update).toHaveBeenCalledTimes(2);
  });
});

describe('createBulkPayout - repli Mobile Money/carte pour un bénéficiaire sans compte FlexPay', () => {
  test('sans externalPayoutMethod, un numéro non inscrit échoue comme avant (comportement historique préservé)', async () => {
    mockPrisma.bulkPayout.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeBulkPayout({ successCount: 0, failedCount: 1, items: [{ id: 'item-1', status: 'FAILED' }] }));
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'biz-owner', accountType: 'BUSINESS', businessProfile: {} })
      .mockResolvedValueOnce(null); // numéro non inscrit
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 10_000_000 });
    mockPrisma.bulkPayout.create.mockResolvedValue({
      id: 'bp-new',
      idempotencyKey: 'batch-key-new',
      items: [{ id: 'item-1', recipientPhone: '+224699999999', amount: 50000, reference: null }],
    });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224699999999', amount: 50000 }],
      idempotencyKey: 'batch-key-new',
    });

    expect(mockExternalPayout).not.toHaveBeenCalled();
    expect(mockMoveFunds).not.toHaveBeenCalled();
    const itemUpdateCall = mockPrisma.bulkPayoutItem.update.mock.calls[0][0];
    expect(itemUpdateCall.data.status).toBe('FAILED');
  });

  test('avec externalPayoutMethod, un numéro non inscrit est payé via Mobile Money au lieu d\'échouer', async () => {
    mockPrisma.bulkPayout.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeBulkPayout({ successCount: 1, failedCount: 0, items: [{ id: 'item-1', status: 'SUCCESS' }] }));
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'biz-owner', accountType: 'BUSINESS', businessProfile: {} })
      .mockResolvedValueOnce(null); // numéro non inscrit
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 10_000_000 });
    mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-external' });
    mockPrisma.bulkPayout.create.mockResolvedValue({
      id: 'bp-new',
      idempotencyKey: 'batch-key-new',
      items: [{ id: 'item-1', recipientPhone: '+224699999999', amount: 50000, reference: null }],
    });
    mockExternalPayout.mockResolvedValue({ status: 'COMPLETED', providerReference: 'MOCK-PAYOUT-ORANGE-abc' });
    mockMoveFunds.mockResolvedValue({ id: 'tx-external-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224699999999', amount: 50000 }],
      idempotencyKey: 'batch-key-new',
      externalPayoutMethod: 'orange_money',
    });

    expect(mockExternalPayout).toHaveBeenCalledWith({ phone: '+224699999999', amount: 50000, provider: 'orange_money' });
    // Le montant quitte le wallet de l'entreprise vers le wallet système externe, jamais vers un wallet bénéficiaire.
    expect(mockMoveFunds.mock.calls[0][0].toWalletId).toBe('wallet-external');

    const itemUpdateCall = mockPrisma.bulkPayoutItem.update.mock.calls[0][0];
    expect(itemUpdateCall.data.status).toBe('SUCCESS');
    expect(itemUpdateCall.data.payoutChannel).toBe('orange_money');
    expect(itemUpdateCall.data.recipientUserId).toBeNull();
  });

  test('si la collecte externe échoue, la ligne reste FAILED et aucun fonds ne bouge', async () => {
    mockPrisma.bulkPayout.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeBulkPayout({ successCount: 0, failedCount: 1, items: [{ id: 'item-1', status: 'FAILED' }] }));
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'biz-owner', accountType: 'BUSINESS', businessProfile: {} })
      .mockResolvedValueOnce(null);
    mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-biz', balance: 10_000_000 });
    mockPrisma.bulkPayout.create.mockResolvedValue({
      id: 'bp-new',
      idempotencyKey: 'batch-key-new',
      items: [{ id: 'item-1', recipientPhone: '+224699999999', amount: 50000, reference: null }],
    });
    mockExternalPayout.mockResolvedValue({ status: 'FAILED' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224699999999', amount: 50000 }],
      idempotencyKey: 'batch-key-new',
      externalPayoutMethod: 'mtn_momo',
    });

    expect(mockMoveFunds).not.toHaveBeenCalled();
    const itemUpdateCall = mockPrisma.bulkPayoutItem.update.mock.calls[0][0];
    expect(itemUpdateCall.data.status).toBe('FAILED');
  });

  test('un bénéficiaire AVEC un compte FlexPay actif passe toujours par le wallet, même si externalPayoutMethod est fourni', async () => {
    mockPrisma.bulkPayout.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeBulkPayout({ successCount: 1, failedCount: 0, items: [{ id: 'item-1', status: 'SUCCESS' }] }));
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'biz-owner', accountType: 'BUSINESS', businessProfile: {} })
      .mockResolvedValueOnce({ id: 'recipient-1', phone: '+224620000001', status: 'ACTIVE' });
    mockGetOrCreateUserWallet
      .mockResolvedValueOnce({ id: 'wallet-biz', balance: 10_000_000 })
      .mockResolvedValueOnce({ id: 'wallet-recipient' });
    mockPrisma.bulkPayout.create.mockResolvedValue({
      id: 'bp-new',
      idempotencyKey: 'batch-key-new',
      items: [{ id: 'item-1', recipientPhone: '+224620000001', amount: 100000, reference: null }],
    });
    mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
    mockPrisma.bulkPayoutItem.update.mockResolvedValue({});
    mockPrisma.bulkPayout.update.mockResolvedValue({});

    await bulkPayoutService.createBulkPayout('biz-owner', {
      items: [{ phone: '+224620000001', amount: 100000 }],
      idempotencyKey: 'batch-key-new',
      externalPayoutMethod: 'orange_money',
    });

    expect(mockExternalPayout).not.toHaveBeenCalled();
    expect(mockMoveFunds.mock.calls[0][0].toWalletId).toBe('wallet-recipient');
    const itemUpdateCall = mockPrisma.bulkPayoutItem.update.mock.calls[0][0];
    expect(itemUpdateCall.data.payoutChannel).toBeNull();
  });
});

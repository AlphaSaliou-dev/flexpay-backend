const mockPrisma = { $queryRaw: jest.fn() };
jest.mock('../../src/config/db', () => mockPrisma);

const {
  findBalanceDiscrepancies,
  findUnbalancedTransactions,
  runReconciliation,
} = require('../../src/modules/wallet/reconciliation.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findBalanceDiscrepancies', () => {
  test('calcule correctement le "drift" (écart) entre solde en cache et solde du grand livre', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { walletId: 'w1', ownerType: 'USER', userId: 'u1', cachedBalance: '105000', ledgerBalance: '100000' },
    ]);

    const result = await findBalanceDiscrepancies();

    expect(result).toEqual([
      { walletId: 'w1', ownerType: 'USER', userId: 'u1', cachedBalance: 105000, ledgerBalance: 100000, drift: 5000 },
    ]);
  });

  test('retourne un tableau vide quand la requête ne renvoie aucune divergence', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    expect(await findBalanceDiscrepancies()).toEqual([]);
  });
});

describe('findUnbalancedTransactions', () => {
  test('remonte les transactions dont le nombre d\'écritures ou le solde net est anormal', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { transactionId: 'tx1', type: 'TRANSFER', entryCount: 1, netAmount: '500' },
    ]);

    const result = await findUnbalancedTransactions();
    expect(result).toEqual([{ transactionId: 'tx1', type: 'TRANSFER', entryCount: 1, netAmount: 500 }]);
  });
});

describe('runReconciliation', () => {
  test('healthy=true uniquement si les deux contrôles sont vides', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const report = await runReconciliation();
    expect(report.healthy).toBe(true);
    expect(report.balanceDiscrepancies).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  test('healthy=false dès qu\'une seule divergence existe', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ walletId: 'w1', ownerType: 'USER', userId: 'u1', cachedBalance: '10', ledgerBalance: '0' }])
      .mockResolvedValueOnce([]);

    const report = await runReconciliation();
    expect(report.healthy).toBe(false);
  });
});

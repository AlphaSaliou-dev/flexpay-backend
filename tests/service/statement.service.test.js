const mockPrisma = {
  wallet: { findUnique: jest.fn(), create: jest.fn() },
  ledgerEntry: { findMany: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const { generateCsvStatement, StatementError } = require('../../src/modules/wallet/statement.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', balance: 500000, currency: 'GNF' });
});

describe('generateCsvStatement', () => {
  test('rejette une plage de dates invalide', async () => {
    await expect(
      generateCsvStatement('user-1', { from: 'pas-une-date', to: '2026-01-01' })
    ).rejects.toThrow(StatementError);
  });

  test('rejette si la date de début est après la date de fin', async () => {
    await expect(
      generateCsvStatement('user-1', { from: '2026-06-01', to: '2026-01-01' })
    ).rejects.toThrow(/doit précéder/);
  });

  test('produit un CSV avec une ligne par écriture, montants et sens traduits', async () => {
    mockPrisma.ledgerEntry.findMany.mockResolvedValue([
      {
        direction: 'CREDIT',
        amount: 1200000,
        balanceAfter: 1200000,
        transactionId: 'tx-1',
        createdAt: new Date('2026-04-02T10:00:00Z'),
        transaction: { type: 'DEPOSIT' },
      },
      {
        direction: 'DEBIT',
        amount: 700000,
        balanceAfter: 500000,
        transactionId: 'tx-2',
        createdAt: new Date('2026-04-05T10:00:00Z'),
        transaction: { type: 'MERCHANT_PAYMENT' },
      },
    ]);

    const csv = await generateCsvStatement('user-1', { from: '2026-04-01', to: '2026-04-30' });

    expect(csv).toContain('Dépôt');
    expect(csv).toContain('Paiement marchand');
    expect(csv).toContain('Crédit');
    expect(csv).toContain('Débit');
    expect(csv).toContain('1200000');
    expect(csv).toContain('500000');
  });
});

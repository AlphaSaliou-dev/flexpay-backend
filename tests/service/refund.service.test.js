const mockPrisma = {
  transaction: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  wallet: { findUnique: jest.fn() },
};

jest.mock('../../src/config/db', () => mockPrisma);

const mockMoveFunds = jest.fn();
jest.mock('../../src/modules/wallet/wallet.service', () => ({
  moveFunds: (...args) => mockMoveFunds(...args),
}));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const { refundTransaction, RefundError } = require('../../src/modules/wallet/refund.service');

function makeTransaction(overrides = {}) {
  return {
    id: 'tx-1',
    type: 'MERCHANT_PAYMENT',
    status: 'COMPLETED',
    ledgerEntries: [
      { direction: 'DEBIT', walletId: 'payer-wallet', amount: 700000 },
      { direction: 'CREDIT', walletId: 'merchant-wallet', amount: 700000 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('refundTransaction', () => {
  test('rejette sans motif fourni', async () => {
    await expect(refundTransaction('admin-1', 'tx-1', '')).rejects.toThrow(RefundError);
    await expect(refundTransaction('admin-1', 'tx-1', '   ')).rejects.toThrow('motif');
  });

  test('rejette si la transaction n\'existe pas', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    await expect(refundTransaction('admin-1', 'tx-inconnue', 'Erreur de saisie')).rejects.toThrow('introuvable');
  });

  test('rejette un type de transaction non remboursable (ex: DEPOSIT)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTransaction({ type: 'DEPOSIT' }));
    await expect(refundTransaction('admin-1', 'tx-1', 'Test')).rejects.toThrow(/ne peut pas être remboursée/);
  });

  test('rejette une transaction qui n\'est pas COMPLETED', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTransaction({ status: 'PENDING' }));
    await expect(refundTransaction('admin-1', 'tx-1', 'Test')).rejects.toThrow(/pas dans un état remboursable/);
  });

  test('rejette un double remboursement de la même transaction', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTransaction());
    mockPrisma.transaction.findFirst.mockResolvedValue({ id: 'tx-refund-deja-fait' });

    await expect(refundTransaction('admin-1', 'tx-1', 'Test')).rejects.toThrow(/déjà été remboursée/);
    expect(mockMoveFunds).not.toHaveBeenCalled();
  });

  test('inverse exactement le sens du mouvement original (le receveur rembourse le payeur)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTransaction());
    mockPrisma.transaction.findFirst.mockResolvedValue(null);
    mockMoveFunds.mockResolvedValue({ id: 'tx-refund-1' });
    mockPrisma.transaction.update.mockResolvedValue({});

    await refundTransaction('admin-1', 'tx-1', 'Produit non livré');

    expect(mockMoveFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        fromWalletId: 'merchant-wallet', // celui qui avait reçu...
        toWalletId: 'payer-wallet',      // ...rembourse celui qui avait payé
        amount: 700000,
        type: 'REFUND',
        idempotencyKey: 'refund:tx-1',
      })
    );

    // La transaction originale doit être marquée REVERSED, et la nouvelle
    // transaction de remboursement doit pointer vers elle - dans les deux sens
    // c'est la seule façon de savoir, plus tard, qu'un remboursement a eu lieu.
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { status: 'REVERSED' },
    });
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-refund-1' },
      data: { reversalOfTransactionId: 'tx-1' },
    });
  });

  test('notifie le titulaire du wallet qui reçoit le remboursement (le payeur d\'origine), pas l\'admin', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTransaction());
    mockPrisma.transaction.findFirst.mockResolvedValue(null);
    mockMoveFunds.mockResolvedValue({ id: 'tx-refund-1' });
    mockPrisma.transaction.update.mockResolvedValue({});
    mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'payer-wallet', userId: 'payer-1' });

    await refundTransaction('admin-1', 'tx-1', 'Produit non livré');

    expect(mockPrisma.wallet.findUnique).toHaveBeenCalledWith({ where: { id: 'payer-wallet' } });
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'payer-1',
      expect.objectContaining({ type: 'REFUND_RECEIVED' }),
      expect.any(String)
    );
  });

  test('rejette si les écritures originales sont mal formées (pas de débit ou pas de crédit)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(
      makeTransaction({ ledgerEntries: [{ direction: 'DEBIT', walletId: 'a', amount: 1000 }] })
    );
    mockPrisma.transaction.findFirst.mockResolvedValue(null);

    await expect(refundTransaction('admin-1', 'tx-1', 'Test')).rejects.toThrow(/mal formée/);
  });
});

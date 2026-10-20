const mockPrisma = {
  transaction: { findUnique: jest.fn() },
  businessProfile: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

jest.mock('../../src/modules/files/files.service', () => ({ getFileBuffer: jest.fn() }));

const { generateReceiptPdf, ReceiptError, getPublicVerificationData } = require('../../src/modules/payments/receipt.service');

function makeTx(overrides = {}) {
  return {
    id: 'tx-1',
    type: 'MERCHANT_PAYMENT',
    amount: 700000,
    createdAt: new Date('2026-04-05T10:00:00Z'),
    initiatedByUserId: 'payer-1',
    metadata: { reference: 'Scolarité' },
    ledgerEntries: [
      { direction: 'DEBIT', wallet: { userId: 'payer-1' } },
      { direction: 'CREDIT', wallet: { userId: 'biz-1' } },
    ],
    ...overrides,
  };
}

function fakeResponse() {
  return {
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    removeListener: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generateReceiptPdf - contrôle d\'accès', () => {
  test('rejette pour une transaction qui n\'est pas un paiement marchand', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTx({ type: 'TRANSFER' }));

    await expect(generateReceiptPdf('tx-1', 'payer-1', fakeResponse())).rejects.toThrow(ReceiptError);
  });

  test('rejette pour une transaction inexistante', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);

    await expect(generateReceiptPdf('tx-inconnue', 'payer-1', fakeResponse())).rejects.toThrow('indisponible');
  });

  test('rejette pour un tiers qui n\'est ni le payeur ni l\'institution destinataire', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTx());

    await expect(generateReceiptPdf('tx-1', 'quelquun-dautre', fakeResponse())).rejects.toThrow('introuvable');
  });

  test('autorise le payeur à consulter son propre reçu', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTx());
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ businessName: 'École Sainte Marie', receiptLogoUrl: null, receiptFooterText: null });
    mockPrisma.user.findUnique.mockResolvedValue({ phone: '+224620000000' });

    await expect(generateReceiptPdf('tx-1', 'payer-1', fakeResponse())).resolves.toBeUndefined();
  });

  test('autorise l\'institution destinataire à consulter le reçu qu\'elle a émis', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTx());
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ businessName: 'École Sainte Marie', receiptLogoUrl: null, receiptFooterText: null });
    mockPrisma.user.findUnique.mockResolvedValue({ phone: '+224620000000' });

    await expect(generateReceiptPdf('tx-1', 'biz-1', fakeResponse())).resolves.toBeUndefined();
  });
});

describe('getPublicVerificationData - accessible sans authentification, volontairement minimal', () => {
  test('rejette pour une transaction inexistante', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    await expect(getPublicVerificationData('tx-inconnue')).rejects.toThrow(ReceiptError);
  });

  test('rejette pour une transaction qui n\'est pas un paiement marchand', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(makeTx({ type: 'TRANSFER' }));
    await expect(getPublicVerificationData('tx-1')).rejects.toThrow(ReceiptError);
  });

  test('retourne uniquement les champs non sensibles - jamais le numéro du payeur ni les champs personnalisés', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(
      makeTx({ metadata: { reference: 'Scolarité', customFields: [{ label: 'Nom de l\'élève', fieldKey: 'nom_de_l_eleve', value: 'Mariama Camara' }] } })
    );
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ businessName: 'École Sainte Marie' });

    const result = await getPublicVerificationData('tx-1');

    expect(result).toEqual({
      transactionId: 'tx-1',
      businessName: 'École Sainte Marie',
      amount: 700000,
      currency: undefined,
      date: expect.any(Date),
    });
    // Vérification explicite : aucune trace du numéro du payeur ni des
    // champs personnalisés dans l'objet retourné, même en cherchant dans
    // sa forme sérialisée complète.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('payer-1');
    expect(serialized).not.toContain('Mariama Camara');
    expect(serialized).not.toContain('élève');
  });
});

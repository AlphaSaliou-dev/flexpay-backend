const mockPrisma = { user: { findUnique: jest.fn() }, transaction: { findUnique: jest.fn() } };
jest.mock('../../src/config/db', () => mockPrisma);

jest.mock('../../src/modules/notifications/notification.service', () => ({ notifyUser: jest.fn() }));

const mockGetOrCreateUserWallet = jest.fn();
const mockGetOrCreateSystemWallet = jest.fn();
const mockMoveFunds = jest.fn();
jest.mock('../../src/modules/wallet/wallet.service', () => ({
  getOrCreateUserWallet: (...args) => mockGetOrCreateUserWallet(...args),
  getOrCreateSystemWallet: (...args) => mockGetOrCreateSystemWallet(...args),
  moveFunds: (...args) => mockMoveFunds(...args),
}));

jest.mock('../../src/modules/wallet/limits.guard', () => ({ assertWithinLimits: jest.fn() }));

const mockAssertCustomFieldsComplete = jest.fn();
jest.mock('../../src/modules/payments/businessPaymentFields.service', () => ({
  assertCustomFieldsComplete: (...args) => mockAssertCustomFieldsComplete(...args),
}));

const { payBusiness } = require('../../src/modules/payments/payments.service');

function makeBusiness(overrides = {}) {
  return {
    id: 'biz-1',
    accountType: 'BUSINESS',
    businessProfile: { reviewStatus: 'APPROVED' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-x', balance: 1000000 });
  mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-fees', balance: 0 });
  mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
  mockPrisma.transaction.findUnique.mockResolvedValue(null);
});

describe('payBusiness - sans customFields (compatibilité)', () => {
  test('ne vérifie aucun champ personnalisé si customFields n\'est pas fourni', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeBusiness());

    await payBusiness({ payerUserId: 'user-1', businessUserId: 'biz-1', amount: 5000, idempotencyKey: 'k1', metadata: {} });

    expect(mockAssertCustomFieldsComplete).not.toHaveBeenCalled();
  });
});

describe('payBusiness - avec customFields', () => {
  test('valide les champs requis AVANT tout mouvement de fonds', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeBusiness());
    mockAssertCustomFieldsComplete.mockRejectedValue(new Error('Champ manquant : Classe'));

    await expect(
      payBusiness({
        payerUserId: 'user-1', businessUserId: 'biz-1', amount: 5000, idempotencyKey: 'k2',
        metadata: {}, customFields: {},
      })
    ).rejects.toThrow('Champ manquant');

    expect(mockMoveFunds).not.toHaveBeenCalled();
  });

  test('fige les libellés des champs dans les métadonnées de la transaction (pas seulement les valeurs brutes)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeBusiness());
    mockAssertCustomFieldsComplete.mockResolvedValue([
      { label: "Nom de l'élève", fieldKey: 'nom_de_l_eleve', required: true },
      { label: 'Classe', fieldKey: 'classe', required: false },
    ]);

    await payBusiness({
      payerUserId: 'user-1', businessUserId: 'biz-1', amount: 700000, idempotencyKey: 'k3',
      metadata: { reference: 'Scolarité Avril' },
      customFields: { nom_de_l_eleve: 'Mariama Camara', classe: 'CM2' },
    });

    const moveFundsCall = mockMoveFunds.mock.calls[0][0];
    expect(moveFundsCall.metadata.reference).toBe('Scolarité Avril');
    expect(moveFundsCall.metadata.customFields).toEqual([
      { label: "Nom de l'élève", fieldKey: 'nom_de_l_eleve', value: 'Mariama Camara' },
      { label: 'Classe', fieldKey: 'classe', value: 'CM2' },
    ]);
  });

  test('un champ optionnel non rempli est enregistré avec une valeur null, jamais omis silencieusement', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeBusiness());
    mockAssertCustomFieldsComplete.mockResolvedValue([
      { label: 'Classe', fieldKey: 'classe', required: false },
    ]);

    await payBusiness({
      payerUserId: 'user-1', businessUserId: 'biz-1', amount: 700000, idempotencyKey: 'k4',
      metadata: {}, customFields: {},
    });

    const moveFundsCall = mockMoveFunds.mock.calls[0][0];
    expect(moveFundsCall.metadata.customFields).toEqual([{ label: 'Classe', fieldKey: 'classe', value: null }]);
  });
});

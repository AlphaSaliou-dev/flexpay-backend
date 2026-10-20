const mockPrisma = {
  user: { findUnique: jest.fn() },
  virtualCard: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockAssertWithinLimits = jest.fn();
jest.mock('../../src/modules/wallet/limits.guard', () => ({
  assertWithinLimits: (...args) => mockAssertWithinLimits(...args),
}));

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

// Le fournisseur "mock" réel du module (aucun appel réseau, toujours un
// succès déterministe) - pas besoin de le mocker à son tour.
const virtualCardService = require('../../src/modules/virtualCard/virtualCard.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateUserWallet.mockResolvedValue({ id: 'wallet-1', balance: 1_000_000 });
  mockGetOrCreateSystemWallet.mockResolvedValue({ id: 'wallet-system', balance: 0 });
  mockMoveFunds.mockResolvedValue({ id: 'tx-1' });
});

describe('issueCard - notification', () => {
  test('notifie l\'émission de la carte', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', kycProfile: { tier: 'TIER_2' } });
    mockPrisma.virtualCard.findUnique.mockResolvedValue(null);
    mockPrisma.virtualCard.create.mockResolvedValue({ id: 'card-1' });

    await virtualCardService.issueCard('user-1');

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'VIRTUAL_CARD_ISSUED' })
    );
  });

  test('ne notifie jamais si une carte existe déjà (rejet avant émission)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', kycProfile: { tier: 'TIER_2' } });
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-existante' });

    await expect(virtualCardService.issueCard('user-1')).rejects.toThrow(/existe déjà/);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

describe('topUp - notification', () => {
  test('notifie le rechargement effectué', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x' });
    mockPrisma.virtualCard.update.mockResolvedValue({ id: 'card-1', balance: 100 });

    await virtualCardService.topUp('user-1', 200000);

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'VIRTUAL_CARD_TOPUP' })
    );
  });

  test('ne notifie jamais si la carte n\'est pas active', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'FROZEN', providerCardId: 'mock_x' });

    await expect(virtualCardService.topUp('user-1', 200000)).rejects.toThrow(/non active/);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

describe('topUp - conversion GNF -> USD (jamais un 1:1 arbitraire)', () => {
  test('crédite le solde carte en USD converti, pas le montant GNF brut', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x' });
    mockPrisma.virtualCard.update.mockResolvedValue({ id: 'card-1', balance: 23.11 });

    // 200000 GNF - 2.5% de frais = 195000 GNF -> converti en USD (taux de
    // config/exchangeRates.js), jamais 195000 tel quel.
    await virtualCardService.topUp('user-1', 200000);

    const updateCall = mockPrisma.virtualCard.update.mock.calls[0][0];
    const incrementedAmount = updateCall.data.balance.increment;
    expect(incrementedAmount).toBeLessThan(100); // certainement pas 195000 GNF tel quel
    expect(incrementedAmount).toBeGreaterThan(0);
  });

  test('le solde renvoyé inclut un équivalent GNF indicatif, calculé à partir du solde USD', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x' });
    mockPrisma.virtualCard.update.mockResolvedValue({ id: 'card-1', balance: 10 });

    const result = await virtualCardService.topUp('user-1', 200000);

    expect(result.card.balanceGnfEquivalent).toBeGreaterThan(0);
    expect(typeof result.card.balanceGnfEquivalent).toBe('number');
  });
});

describe('getMyCard / issueCard / freezeCard / unfreezeCard - équivalent GNF toujours présent', () => {
  test('getMyCard renvoie balanceGnfEquivalent en plus du solde USD', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', balance: 50 });

    const card = await virtualCardService.getMyCard('user-1');

    expect(card.balanceGnfEquivalent).toBeGreaterThan(0);
  });

  test('issueCard renvoie balanceGnfEquivalent (0 pour une carte neuve)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', kycProfile: { tier: 'TIER_2' } });
    mockPrisma.virtualCard.findUnique.mockResolvedValue(null);
    mockPrisma.virtualCard.create.mockResolvedValue({ id: 'card-1', balance: 0 });

    const card = await virtualCardService.issueCard('user-1');

    expect(card.balanceGnfEquivalent).toBe(0);
  });
});

describe('freezeCard / unfreezeCard - notifications', () => {
  test('notifie le gel de la carte', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x' });
    mockPrisma.virtualCard.update.mockResolvedValue({ id: 'card-1', status: 'FROZEN' });

    await virtualCardService.freezeCard('user-1');

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'VIRTUAL_CARD_FROZEN' })
    );
  });

  test('notifie le dégel de la carte', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'FROZEN', providerCardId: 'mock_x' });
    mockPrisma.virtualCard.update.mockResolvedValue({ id: 'card-1', status: 'ACTIVE' });

    await virtualCardService.unfreezeCard('user-1');

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'VIRTUAL_CARD_UNFROZEN' })
    );
  });
});

describe('revealDetails - numéro complet, CVC et expiration', () => {
  test('rejette si la carte est fermée', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'CLOSED', providerCardId: 'mock_x', maskedNumber: '**** **** **** 4242' });

    await expect(virtualCardService.revealDetails('user-1')).rejects.toThrow(/non disponible/);
  });

  test('autorise la consultation même si la carte est gelée (le gel bloque les paiements, pas la consultation)', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'FROZEN', providerCardId: 'mock_x', maskedNumber: '**** **** **** 4242' });

    await expect(virtualCardService.revealDetails('user-1')).resolves.toBeDefined();
  });

  test('renvoie un numéro se terminant par les mêmes 4 chiffres que la version masquée', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x', maskedNumber: '**** **** **** 4242' });

    const details = await virtualCardService.revealDetails('user-1');

    expect(details.number.replace(/\s/g, '')).toMatch(/4242$/);
    expect(details.number.replace(/\D/g, '')).toHaveLength(16);
    expect(details.cvc).toMatch(/^\d{3}$/);
    expect(details.expiryMonth).toMatch(/^\d{2}$/);
    expect(details.expiryYear).toMatch(/^\d{2}$/);
  });

  test('renvoie toujours le même numéro pour la même carte (jamais régénéré à chaque appel)', async () => {
    mockPrisma.virtualCard.findUnique.mockResolvedValue({ id: 'card-1', status: 'ACTIVE', providerCardId: 'mock_x', maskedNumber: '**** **** **** 4242' });

    const first = await virtualCardService.revealDetails('user-1');
    const second = await virtualCardService.revealDetails('user-1');

    expect(second).toEqual(first);
  });
});

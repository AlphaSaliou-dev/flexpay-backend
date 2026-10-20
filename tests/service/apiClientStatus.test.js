const mockPrisma = { apiClient: { findMany: jest.fn() } };
jest.mock('../../src/config/db', () => mockPrisma);

const { getMyApiClientStatus } = require('../../src/modules/payments/payments.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getMyApiClientStatus', () => {
  test('retourne un tableau vide si aucune clé API n\'est associée à ce compte', async () => {
    mockPrisma.apiClient.findMany.mockResolvedValue([]);
    const result = await getMyApiClientStatus('user-sans-cle');
    expect(result).toEqual([]);
  });

  test('retourne les deux clés (LIVE et TEST) quand elles existent, sans jamais exposer le hash', async () => {
    mockPrisma.apiClient.findMany.mockResolvedValue([
      { name: 'MarketConnect', apiKeyPrefix: 'fp_live_8f2a', environment: 'LIVE', status: 'ACTIVE', createdAt: new Date('2026-01-01') },
      { name: 'MarketConnect', apiKeyPrefix: 'fp_test_3c1d', environment: 'TEST', status: 'ACTIVE', createdAt: new Date('2026-01-02') },
    ]);

    const result = await getMyApiClientStatus('user-avec-cles');

    expect(result).toHaveLength(2);
    expect(result[0].apiKeyHash).toBeUndefined();
    expect(result[1].apiKeyHash).toBeUndefined();

    // Vérifie aussi que la requête elle-même ne demande jamais le hash -
    // pas seulement qu'il est absent du résultat renvoyé.
    expect(mockPrisma.apiClient.findMany.mock.calls[0][0].select).not.toHaveProperty('apiKeyHash');
  });
});

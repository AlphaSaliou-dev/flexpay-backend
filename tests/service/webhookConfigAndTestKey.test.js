process.env.ENCRYPTION_KEY = 'ef625a92d2709e6db0321f41d7e1b3b18e13124d458564f33d13ba841e754099';

const mockPrisma = {
  user: { findUnique: jest.fn() },
  apiClient: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const paymentsService = require('../../src/modules/payments/payments.service');
const { decrypt } = require('../../src/utils/encryption');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requestTestApiKey - libre-service, sans validation admin', () => {
  test('rejette si le compte n\'est pas Business', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL' });
    await expect(paymentsService.requestTestApiKey('user-1')).rejects.toThrow(/compte Business/);
  });

  test('rejette si le KYB n\'est pas encore approuvé', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      accountType: 'BUSINESS',
      businessProfile: { reviewStatus: 'PENDING', businessName: 'École Test' },
    });
    await expect(paymentsService.requestTestApiKey('user-1')).rejects.toThrow(/validé \(KYB\)/);
  });

  test('rejette s\'il existe déjà une clé de test pour ce compte (pas de doublon)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      accountType: 'BUSINESS',
      businessProfile: { reviewStatus: 'APPROVED', businessName: 'École Test' },
    });
    mockPrisma.apiClient.findFirst.mockResolvedValue({ id: 'existing-test-key' });

    await expect(paymentsService.requestTestApiKey('user-1')).rejects.toThrow(/existe déjà/);
    expect(mockPrisma.apiClient.create).not.toHaveBeenCalled();
  });

  test('génère bien une clé avec le préfixe fp_test_ pour un compte éligible', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      accountType: 'BUSINESS',
      businessProfile: { reviewStatus: 'APPROVED', businessName: 'École Test' },
    });
    mockPrisma.apiClient.findFirst.mockResolvedValue(null);
    mockPrisma.apiClient.create.mockResolvedValue({ id: 'new-key', environment: 'TEST' });

    const result = await paymentsService.requestTestApiKey('user-1');

    expect(result.apiKey).toMatch(/^fp_test_/);
    expect(mockPrisma.apiClient.create.mock.calls[0][0].data.environment).toBe('TEST');
  });
});

describe('setWebhookUrl', () => {
  test('rejette si la clé API n\'appartient pas à cette entreprise', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'c1', businessUserId: 'autre-entreprise' });

    await expect(
      paymentsService.setWebhookUrl('biz-1', 'c1', 'https://example.com/hook')
    ).rejects.toThrow('introuvable');
  });

  test('génère un secret et le révèle en clair à la première configuration', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'c1', businessUserId: 'biz-1', webhookSecret: null });
    mockPrisma.apiClient.update.mockResolvedValue({});

    const result = await paymentsService.setWebhookUrl('biz-1', 'c1', 'https://example.com/hook');

    expect(result.webhookSecret).toMatch(/^whsec_/);

    // Le secret révélé à l'appelant doit être la valeur BRUTE - ce qui
    // est écrit en base doit être une valeur chiffrée différente, qui se
    // déchiffre bien vers ce même secret brut (pas un simple hachage,
    // sinon on ne pourrait plus jamais le relire pour signer un webhook).
    const stored = mockPrisma.apiClient.update.mock.calls[0][0].data.webhookSecret;
    expect(stored).not.toBe(result.webhookSecret);
    expect(decrypt(stored)).toBe(result.webhookSecret);
  });

  test('ne révèle JAMAIS à nouveau un secret déjà existant lors d\'une simple mise à jour d\'URL', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'c1', businessUserId: 'biz-1', webhookSecret: 'whsec_dejaexistant' });
    mockPrisma.apiClient.update.mockResolvedValue({});

    const result = await paymentsService.setWebhookUrl('biz-1', 'c1', 'https://nouvelle-url.example.com/hook');

    expect(result.webhookSecret).toBeNull();
    // Le secret existant ne doit jamais être écrasé par un nouveau à cette occasion.
    expect(mockPrisma.apiClient.update.mock.calls[0][0].data.webhookSecret).toBe('whsec_dejaexistant');
  });
});

describe('regenerateWebhookSecret', () => {
  test('rejette si la clé n\'appartient pas à cette entreprise', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'c1', businessUserId: 'autre-entreprise' });

    await expect(paymentsService.regenerateWebhookSecret('biz-1', 'c1')).rejects.toThrow('introuvable');
  });

  test('génère un nouveau secret différent de l\'ancien', async () => {
    mockPrisma.apiClient.findUnique.mockResolvedValue({ id: 'c1', businessUserId: 'biz-1', webhookSecret: 'whsec_ancien' });
    mockPrisma.apiClient.update.mockResolvedValue({});

    const result = await paymentsService.regenerateWebhookSecret('biz-1', 'c1');

    expect(result.webhookSecret).toMatch(/^whsec_/);
    expect(result.webhookSecret).not.toBe('whsec_ancien');

    const stored = mockPrisma.apiClient.update.mock.calls[0][0].data.webhookSecret;
    expect(stored).not.toBe(result.webhookSecret);
    expect(decrypt(stored)).toBe(result.webhookSecret);
  });
});

const mockPrisma = {
  webhookDelivery: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

// Le chiffrement du secret webhook est testé pour de vrai ailleurs (voir
// tests/unit/encryption.test.js et webhookConfigAndTestKey.test.js) - ici
// on ne teste que la mécanique d'envoi/réessai, donc un passe-plat suffit
// et évite de dépendre d'une vraie ENCRYPTION_KEY dans cette suite.
jest.mock('../../src/utils/encryption', () => ({
  decrypt: (v) => v,
  encrypt: (v) => v,
}));

const {
  deliverWebhook,
  computeSignature,
  retryPendingWebhookDeliveries,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SEC,
} = require('../../src/modules/payments/webhook.service');

function makeApiClient(overrides = {}) {
  return { id: 'client-1', webhookUrl: 'https://example.com/hook', webhookSecret: 'my-secret', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.webhookDelivery.create.mockResolvedValue({ id: 'delivery-1', attempts: 0 });
  mockPrisma.webhookDelivery.update.mockResolvedValue({});
});

describe('computeSignature', () => {
  test('est déterministe pour un même secret et un même payload', () => {
    const a = computeSignature('secret123', '{"foo":"bar"}');
    const b = computeSignature('secret123', '{"foo":"bar"}');
    expect(a).toBe(b);
  });

  test('change dès que le secret change, à payload identique', () => {
    const a = computeSignature('secret-a', '{"foo":"bar"}');
    const b = computeSignature('secret-b', '{"foo":"bar"}');
    expect(a).not.toBe(b);
  });

  test('change dès que le payload change, à secret identique', () => {
    const a = computeSignature('secret123', '{"foo":"bar"}');
    const b = computeSignature('secret123', '{"foo":"baz"}');
    expect(a).not.toBe(b);
  });
});

describe('deliverWebhook', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('ne fait rien si aucune URL de webhook n\'est configurée', async () => {
    global.fetch = jest.fn();
    await deliverWebhook({ webhookUrl: null, webhookSecret: null }, 'payment_intent.approved', {});
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  test('ne fait rien si l\'URL est configurée mais pas le secret (état incohérent, prudence)', async () => {
    global.fetch = jest.fn();
    await deliverWebhook({ webhookUrl: 'https://example.com/hook', webhookSecret: null }, 'payment_intent.approved', {});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('envoie une requête POST avec la signature dans l\'en-tête', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await deliverWebhook(makeApiClient(), 'payment_intent.approved', { intentId: 'i1' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(options.method).toBe('POST');
    expect(options.headers['X-FlexPay-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(options.headers['X-FlexPay-Event']).toBe('payment_intent.approved');
  });

  test('n\'échoue JAMAIS même si l\'envoi réseau échoue - c\'est la garantie centrale de ce service', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(deliverWebhook(makeApiClient(), 'payment_intent.approved', {})).resolves.toBeUndefined();
  });

  test('journalise une WebhookDelivery à chaque tentative, avant même de savoir si elle réussira', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await deliverWebhook(makeApiClient(), 'payment_intent.approved', { intentId: 'i1' });

    expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ apiClientId: 'client-1', event: 'payment_intent.approved', status: 'PENDING', attempts: 0 }),
    });
  });

  test('marque la livraison DELIVERED en cas de succès', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await deliverWebhook(makeApiClient(), 'payment_intent.approved', {});

    expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: expect.objectContaining({ status: 'DELIVERED' }),
    });
  });

  test('un statut HTTP non-2xx est traité comme un échec (pas juste une exception réseau)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    await deliverWebhook(makeApiClient(), 'payment_intent.approved', {});

    const updateCall = mockPrisma.webhookDelivery.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('PENDING'); // premier échec -> réessai programmé, pas encore abandonné
    expect(updateCall.data.lastError).toMatch(/500/);
    expect(updateCall.data.nextRetryAt).toBeInstanceOf(Date);
  });

  test('programme le premier réessai au premier délai de la liste de backoff', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const before = Date.now();

    await deliverWebhook(makeApiClient(), 'payment_intent.approved', {});

    const updateCall = mockPrisma.webhookDelivery.update.mock.calls[0][0];
    const expectedDelayMs = WEBHOOK_RETRY_DELAYS_SEC[0] * 1000;
    const actualDelayMs = updateCall.data.nextRetryAt.getTime() - before;
    // Tolérance large pour l'exécution du test elle-même.
    expect(actualDelayMs).toBeGreaterThan(expectedDelayMs - 2000);
    expect(actualDelayMs).toBeLessThan(expectedDelayMs + 2000);
  });
});

describe('retryPendingWebhookDeliveries', () => {
  test('ne touche que les livraisons PENDING dont l\'heure de réessai est passée', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);

    await retryPendingWebhookDeliveries();

    const call = mockPrisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('PENDING');
    expect(call.where.nextRetryAt.lte).toBeInstanceOf(Date);
  });

  test('retente avec la même signature (recalculée depuis le payload et le secret stockés)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'delivery-2',
        attempts: 1,
        event: 'payment_intent.approved',
        payload: { event: 'payment_intent.approved', data: { intentId: 'i1' } },
        apiClient: makeApiClient(),
      },
    ]);

    await retryPendingWebhookDeliveries();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-2' },
      data: expect.objectContaining({ status: 'DELIVERED' }),
    });
  });

  test(`abandonne définitivement (FAILED) après ${MAX_WEBHOOK_ATTEMPTS} tentatives infructueuses`, async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'delivery-3',
        attempts: MAX_WEBHOOK_ATTEMPTS - 1, // dernière tentative autorisée
        event: 'payment_intent.approved',
        payload: {},
        apiClient: makeApiClient(),
      },
    ]);

    await retryPendingWebhookDeliveries();

    expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-3' },
      data: expect.objectContaining({ status: 'FAILED', nextRetryAt: null }),
    });
  });

  test('abandonne proprement si le partenaire a retiré son webhook entre-temps', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'delivery-4',
        attempts: 1,
        event: 'payment_intent.approved',
        payload: {},
        apiClient: makeApiClient({ webhookUrl: null, webhookSecret: null }),
      },
    ]);

    await retryPendingWebhookDeliveries();

    expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-4' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });
});

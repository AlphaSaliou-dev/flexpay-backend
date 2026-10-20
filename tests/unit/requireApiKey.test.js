const mockPrisma = {
  apiClient: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockHashApiKey = jest.fn(() => 'hashed-key');
jest.mock('../../src/modules/payments/apiKey.util', () => ({
  hashApiKey: (...args) => mockHashApiKey(...args),
}));

const { requireApiKey } = require('../../src/modules/payments/requireApiKey');

function makeReqRes(overrides = {}) {
  const req = { headers: { 'x-api-key': 'fp_live_test' }, ip: '41.207.0.1', ...overrides };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

function makeApiClient(overrides = {}) {
  return { id: 'client-1', status: 'ACTIVE', expiresAt: null, allowedIps: [], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.apiClient.update.mockResolvedValue({});
});

test('rejette si l\'en-tête x-api-key est absent', async () => {
  const { req, res, next } = makeReqRes({ headers: {} });
  await requireApiKey(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});

test('rejette une clé inconnue ou révoquée', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(null);
  const { req, res, next } = makeReqRes();
  await requireApiKey(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});

test('rejette une clé SUSPENDED même si elle existe', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ status: 'SUSPENDED' }));
  const { req, res, next } = makeReqRes();
  await requireApiKey(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
});

test('rejette une clé expirée', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ expiresAt: new Date(Date.now() - 60000) }));
  const { req, res, next } = makeReqRes();
  await requireApiKey(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/expirée/) }));
  expect(next).not.toHaveBeenCalled();
});

test('accepte une clé dont l\'expiration est dans le futur', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ expiresAt: new Date(Date.now() + 60000) }));
  const { req, res, next } = makeReqRes();
  await requireApiKey(req, res, next);
  expect(next).toHaveBeenCalled();
});

test('rejette une IP hors de la liste autorisée quand une restriction est configurée', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ allowedIps: ['1.2.3.4'] }));
  const { req, res, next } = makeReqRes({ ip: '9.9.9.9' });
  await requireApiKey(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('accepte une IP présente dans la liste autorisée', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ allowedIps: ['41.207.0.1'] }));
  const { req, res, next } = makeReqRes({ ip: '41.207.0.1' });
  await requireApiKey(req, res, next);
  expect(next).toHaveBeenCalled();
});

test('aucune restriction d\'IP par défaut (allowedIps vide = toute IP acceptée)', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient({ allowedIps: [] }));
  const { req, res, next } = makeReqRes({ ip: 'n\'importe-quoi' });
  await requireApiKey(req, res, next);
  expect(next).toHaveBeenCalled();
});

test('met à jour lastUsedAt sans jamais bloquer next() en attendant cette écriture', async () => {
  mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient());
  let resolveUpdate;
  mockPrisma.apiClient.update.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));

  const { req, res, next } = makeReqRes();
  await requireApiKey(req, res, next);

  // next() doit déjà avoir été appelé alors que la promesse d'update est
  // toujours pendante - la mise à jour n'est jamais attendue (pas de await).
  expect(next).toHaveBeenCalled();
  resolveUpdate({});
});

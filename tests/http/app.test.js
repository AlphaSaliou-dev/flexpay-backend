process.env.JWT_ACCESS_SECRET = 'test_secret';
process.env.JWT_ADMIN_SECRET = 'test_admin_secret';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn() },
  refreshToken: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn((ops) => Promise.all(ops)),
};

jest.mock('../../src/config/db', () => mockPrisma);
jest.mock('../../src/utils/otp', () => ({
  generateOtpCode: () => '123456',
  hashOtpCode: async (c) => `hashed:${c}`,
  verifyOtpCode: async () => true,
  otpExpiryDate: () => new Date(Date.now() + 5 * 60000),
  sendOtpBySms: jest.fn(),
}));

const request = require('supertest');
const app = require('../../src/app');

describe('GET /health', () => {
  test('répond 200 avec le statut ok, sans dépendre de la base', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/v1/auth/register - validation', () => {
  test('rejette un numéro de téléphone qui n\'est pas au format guinéen', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      phone: '0612345678', // format français, pas +224
      password: 'Password1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Requête invalide/);
  });

  test('rejette un mot de passe trop court', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      phone: '+224620000000',
      password: 'Ab1',
    });
    expect(res.status).toBe(400);
  });

  test('rejette un mot de passe sans majuscule', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      phone: '+224620000000',
      password: 'password1',
    });
    expect(res.status).toBe(400);
  });

  test('accepte une inscription valide et appelle bien la couche service', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'user-1', phone: '+224620000000', status: 'PENDING_VERIFICATION' });
    mockPrisma.otpCode.create.mockResolvedValue({});

    const res = await request(app).post('/api/v1/auth/register').send({
      phone: '+224620000000',
      password: 'Password1',
      acceptedTerms: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+224620000000');
  });

  test('rejette une inscription sans acceptation des CGU/politique de confidentialité', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      phone: '+224620000000',
      password: 'Password1',
    });
    expect(res.status).toBe(400);
  });
});

describe('Routes protégées', () => {
  test('rejette un appel sans token sur une route qui exige requireAuth', async () => {
    const res = await request(app).get('/api/v1/wallet/balance');
    expect(res.status).toBe(401);
  });

  test('rejette un token malformé', async () => {
    const res = await request(app).get('/api/v1/wallet/balance').set('Authorization', 'Bearer ceci-nest-pas-un-jwt');
    expect(res.status).toBe(401);
  });
});

describe('Route inconnue', () => {
  test('renvoie 404 proprement plutôt qu\'un crash', async () => {
    const res = await request(app).get('/api/v1/route-qui-nexiste-pas');
    expect(res.status).toBe(404);
  });
});

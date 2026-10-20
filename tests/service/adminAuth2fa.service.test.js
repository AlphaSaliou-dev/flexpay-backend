process.env.JWT_ADMIN_SECRET = 'test_admin_secret_for_2fa_tests';
process.env.JWT_ADMIN_EXPIRES_IN = '8h';

const otplib = require('otplib');

const mockPrisma = {
  adminUser: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const adminAuthService = require('../../src/modules/admin/adminAuth.service');
const argon2 = require('argon2');

function makeAdmin(overrides = {}) {
  return {
    id: 'admin-1',
    email: 'admin@flexpay.gn',
    role: 'SUPERADMIN',
    status: 'ACTIVE',
    totpEnabled: false,
    totpSecret: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('login - première connexion (2FA pas encore configurée)', () => {
  test('renvoie setupRequired avec un secret et un QR code, jamais de token complet', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.adminUser.findUnique.mockResolvedValue(makeAdmin({ passwordHash }));
    mockPrisma.adminUser.update.mockResolvedValue({});

    const result = await adminAuthService.login({ email: 'admin@flexpay.gn', password: 'CorrectPassword1' });

    expect(result.setupRequired).toBe(true);
    expect(result.secret).toBeDefined();
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.token).toBeUndefined(); // jamais de session complète avant que le 2FA soit confirmé
  });
});

describe('confirmTotpSetup', () => {
  test('active le 2FA et délivre un vrai token quand le code est correct', async () => {
    const secret = await otplib.generateSecret();
    const admin = makeAdmin({ totpSecret: secret });
    mockPrisma.adminUser.findUnique.mockResolvedValue(admin);
    mockPrisma.adminUser.update.mockResolvedValue({});

    const pendingToken = adminAuthService.signAdminToken; // juste pour l'import, non utilisé directement ici
    const { login } = adminAuthService;
    void login;

    // On fabrique un pendingToken valide directement (même mécanisme que login())
    const jwt = require('jsonwebtoken');
    const validPendingToken = jwt.sign({ sub: admin.id, aud: 'flexpay-admin-2fa-pending' }, process.env.JWT_ADMIN_SECRET, { expiresIn: '2m' });

    const realCode = await otplib.generate({ secret });
    const result = await adminAuthService.confirmTotpSetup(validPendingToken, realCode);

    expect(result.token).toBeDefined();
    expect(mockPrisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: admin.id },
      data: { totpEnabled: true, lastLoginAt: expect.any(Date) },
    });
  });

  test('rejette un mauvais code, sans jamais activer le 2FA', async () => {
    const secret = await otplib.generateSecret();
    const admin = makeAdmin({ totpSecret: secret });
    mockPrisma.adminUser.findUnique.mockResolvedValue(admin);

    const jwt = require('jsonwebtoken');
    const validPendingToken = jwt.sign({ sub: admin.id, aud: 'flexpay-admin-2fa-pending' }, process.env.JWT_ADMIN_SECRET, { expiresIn: '2m' });

    await expect(adminAuthService.confirmTotpSetup(validPendingToken, '000000')).rejects.toThrow(/invalide/);
    expect(mockPrisma.adminUser.update).not.toHaveBeenCalled();
  });
});

describe('verifyTotp - connexions suivantes (2FA déjà configurée)', () => {
  test('délivre un token avec un code TOTP correct', async () => {
    const secret = await otplib.generateSecret();
    const admin = makeAdmin({ totpEnabled: true, totpSecret: secret });
    mockPrisma.adminUser.findUnique.mockResolvedValue(admin);
    mockPrisma.adminUser.update.mockResolvedValue({});

    const jwt = require('jsonwebtoken');
    const pendingToken = jwt.sign({ sub: admin.id, aud: 'flexpay-admin-2fa-pending' }, process.env.JWT_ADMIN_SECRET, { expiresIn: '2m' });

    const realCode = await otplib.generate({ secret });
    const result = await adminAuthService.verifyTotp(pendingToken, realCode);

    expect(result.token).toBeDefined();
    expect(result.admin.email).toBe('admin@flexpay.gn');
  });

  test('rejette un code TOTP incorrect', async () => {
    const secret = await otplib.generateSecret();
    const admin = makeAdmin({ totpEnabled: true, totpSecret: secret });
    mockPrisma.adminUser.findUnique.mockResolvedValue(admin);

    const jwt = require('jsonwebtoken');
    const pendingToken = jwt.sign({ sub: admin.id, aud: 'flexpay-admin-2fa-pending' }, process.env.JWT_ADMIN_SECRET, { expiresIn: '2m' });

    await expect(adminAuthService.verifyTotp(pendingToken, '111111')).rejects.toThrow(/invalide/);
  });

  test('rejette un pendingToken expiré ou invalide', async () => {
    await expect(adminAuthService.verifyTotp('token-invalide', '123456')).rejects.toThrow(/expirée/);
  });
});

describe('Isolation des audiences JWT - le coeur de la garantie de sécurité', () => {
  test('un pendingToken (2FA en attente) ne peut JAMAIS être accepté comme token de session complète', () => {
    const jwt = require('jsonwebtoken');
    const pendingToken = jwt.sign({ sub: 'admin-1', aud: 'flexpay-admin-2fa-pending' }, process.env.JWT_ADMIN_SECRET, { expiresIn: '2m' });

    // verifyAdminToken (utilisé par requireAdminAuth pour protéger TOUTES
    // les routes admin) doit rejeter ce token à cause de l'audience
    // différente - même s'il est signé avec le bon secret.
    expect(() => adminAuthService.verifyAdminToken(pendingToken)).toThrow();
  });

  test('un vrai token de session ne peut pas être réutilisé comme pendingToken', async () => {
    const jwt = require('jsonwebtoken');
    const fullToken = adminAuthService.signAdminToken({ id: 'admin-1', role: 'SUPERADMIN' });

    // Rejouer un token de session complet sur l'étape de vérification 2FA
    // doit aussi échouer, pour la même raison inversée.
    await expect(adminAuthService.verifyTotp(fullToken, '123456')).rejects.toThrow();
    void jwt;
  });
});

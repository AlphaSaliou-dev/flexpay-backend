process.env.JWT_ACCESS_SECRET = 'test_secret';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.MAX_FAILED_LOGIN_ATTEMPTS = '5';
process.env.ACCOUNT_LOCK_MINUTES = '15';
process.env.OTP_MAX_ATTEMPTS = '3';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  refreshToken: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn((ops) => Promise.all(ops)),
};

jest.mock('../../src/config/db', () => mockPrisma);

const mockVerifyOtpCode = jest.fn(async () => true);
jest.mock('../../src/utils/otp', () => ({
  generateOtpCode: () => '123456',
  hashOtpCode: async (c) => `hashed:${c}`,
  verifyOtpCode: (...args) => mockVerifyOtpCode(...args),
  otpExpiryDate: () => new Date(Date.now() + 5 * 60000),
  sendOtpBySms: jest.fn(),
}));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const authService = require('../../src/modules/auth/auth.service');
const argon2 = require('argon2');

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    phone: '+224620000000',
    passwordHash: null, // rempli dans les tests qui en ont besoin
    status: 'ACTIVE',
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyOtpCode.mockResolvedValue(true);
});

describe('login', () => {
  test('renvoie le même message d\'erreur pour un numéro inexistant et un mauvais mot de passe (anti-énumération)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    let errorForUnknownPhone;
    try {
      await authService.login({ phone: '+224699999999', password: 'x' });
    } catch (e) {
      errorForUnknownPhone = e.message;
    }

    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser({ passwordHash }));
    let errorForWrongPassword;
    try {
      await authService.login({ phone: '+224620000000', password: 'WrongPassword1' });
    } catch (e) {
      errorForWrongPassword = e.message;
    }

    expect(errorForUnknownPhone).toBe(errorForWrongPassword);
    expect(errorForUnknownPhone).toBe('Identifiants invalides');
  });

  test('verrouille le compte après le nombre configuré de tentatives échouées', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash, failedLoginAttempts: 4 }));

    await expect(authService.login({ phone: '+224620000000', password: 'wrong' })).rejects.toThrow();

    // À la 5ème tentative (4 précédentes + celle-ci), le compte doit être
    // verrouillé : failedLoginAttempts repart à 0 et lockedUntil est posé.
    const updateCall = mockPrisma.user.update.mock.calls[0][0];
    expect(updateCall.data.failedLoginAttempts).toBe(0);
    expect(updateCall.data.lockedUntil).toBeInstanceOf(Date);

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'ACCOUNT_LOCKED' }),
      expect.any(String)
    );
  });

  test('ne notifie PAS de verrouillage tant que le seuil de tentatives n\'est pas atteint', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash, failedLoginAttempts: 1 }));

    await expect(authService.login({ phone: '+224620000000', password: 'wrong' })).rejects.toThrow();

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('rejette la connexion tant que le verrouillage n\'est pas expiré', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ passwordHash, lockedUntil: new Date(Date.now() + 10 * 60000) })
    );

    await expect(
      authService.login({ phone: '+224620000000', password: 'CorrectPassword1' })
    ).rejects.toThrow(/verrouillé/);
  });

  test('une connexion réussie réinitialise le compteur de tentatives échouées', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash, failedLoginAttempts: 3 }));
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.refreshToken.create.mockResolvedValue({});

    await authService.login({ phone: '+224620000000', password: 'CorrectPassword1' });

    const resetCall = mockPrisma.user.update.mock.calls[0][0];
    expect(resetCall.data.failedLoginAttempts).toBe(0);
    expect(resetCall.data.lockedUntil).toBeNull();
  });

  test('notifie une connexion réussie (alerte de sécurité)', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.refreshToken.create.mockResolvedValue({});

    await authService.login({ phone: '+224620000000', password: 'CorrectPassword1' }, '1.2.3.4');

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'NEW_LOGIN' }),
      expect.any(String)
    );
  });

  test('rejette un compte dont le téléphone n\'est pas encore vérifié', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash, status: 'PENDING_VERIFICATION' }));

    await expect(
      authService.login({ phone: '+224620000000', password: 'CorrectPassword1' })
    ).rejects.toThrow(/non vérifié/);
  });

  test('rejette un compte suspendu, même avec le bon mot de passe', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash, status: 'SUSPENDED' }));

    await expect(
      authService.login({ phone: '+224620000000', password: 'CorrectPassword1' })
    ).rejects.toThrow(/suspendu/);
  });
});

describe('register', () => {
  test('rejette une inscription avec un message générique si le numéro existe déjà', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());

    await expect(
      authService.register({ phone: '+224620000000', password: 'Password1', declaresCommercialUse: false })
    ).rejects.toThrow('Impossible de créer le compte avec ces informations');
  });

  test('enregistre bien la déclaration d\'usage commercial à l\'inscription', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(makeUser({ status: 'PENDING_VERIFICATION' }));
    mockPrisma.otpCode.create.mockResolvedValue({});

    await authService.register({ phone: '+224620000000', password: 'Password1', declaresCommercialUse: true });

    expect(mockPrisma.user.create.mock.calls[0][0].data.declaresCommercialUse).toBe(true);
  });

  test("horodate l'acceptation des CGU/politique de confidentialité à l'inscription", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(makeUser({ status: 'PENDING_VERIFICATION' }));
    mockPrisma.otpCode.create.mockResolvedValue({});

    await authService.register({ phone: '+224620000000', password: 'Password1', acceptedTerms: true });

    expect(mockPrisma.user.create.mock.calls[0][0].data.termsAcceptedAt).toBeInstanceOf(Date);
  });
});

describe('getProfile', () => {
  test('renvoie id, téléphone et nom complet - jamais le hash du mot de passe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1', phone: '+224620000000', fullName: 'Aïssatou Camara', passwordHash: 'secret-hash',
    });

    const result = await authService.getProfile('user-1');

    expect(result).toEqual({ id: 'user-1', phone: '+224620000000', fullName: 'Aïssatou Camara' });
    expect(result).not.toHaveProperty('passwordHash');
  });

  test('lève une erreur si l\'utilisateur est introuvable', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(authService.getProfile('inconnu')).rejects.toThrow('introuvable');
  });
});

describe('updateProfile', () => {
  test('met à jour uniquement le nom complet, jamais le téléphone (identifiant immuable)', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', phone: '+224620000000', fullName: 'Nouveau Nom' });

    const result = await authService.updateProfile('user-1', { fullName: 'Nouveau Nom' });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { fullName: 'Nouveau Nom' },
    });
    expect(result).toEqual({ id: 'user-1', phone: '+224620000000', fullName: 'Nouveau Nom' });
  });

  test('journalise la modification du profil', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', phone: '+224620000000', fullName: 'Nouveau Nom' });

    await authService.updateProfile('user-1', { fullName: 'Nouveau Nom' });

    const auditCalls = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).toContain('PROFILE_UPDATED');
  });
});

describe('changePassword', () => {
  test('rejette si le mot de passe actuel est incorrect', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));

    await expect(
      authService.changePassword('user-1', { currentPassword: 'MauvaisMotDePasse1', newPassword: 'NouveauPassword1' })
    ).rejects.toThrow('Mot de passe actuel incorrect');

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('notifie le changement de mot de passe (alerte de sécurité)', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

    await authService.changePassword('user-1', {
      currentPassword: 'CorrectPassword1',
      newPassword: 'NouveauPassword1',
    });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'PASSWORD_CHANGED' }),
      expect.any(String)
    );
  });

  test('change le mot de passe et révoque toutes les sessions actives', async () => {
    const passwordHash = await argon2.hash('CorrectPassword1');
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

    const result = await authService.changePassword('user-1', {
      currentPassword: 'CorrectPassword1',
      newPassword: 'NouveauPassword1',
    });

    expect(result).toEqual({ changed: true });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: expect.any(String) },
    });
    // Le point de sécurité le plus important de cette fonction : toute
    // session déjà ouverte (potentiellement volée) doit être coupée.
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('getTransactionPinStatus', () => {
  test('renvoie isSet=false quand aucun PIN n\'a jamais été défini', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ transactionPinHash: null }));
    await expect(authService.getTransactionPinStatus('user-1')).resolves.toEqual({ isSet: false });
  });

  test('renvoie isSet=true quand un PIN existe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ transactionPinHash: 'hash-existant' }));
    await expect(authService.getTransactionPinStatus('user-1')).resolves.toEqual({ isSet: true });
  });
});

describe('setTransactionPin', () => {
  test('définit le PIN (première fois) sans aucune preuve supplémentaire, sans notifier', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ transactionPinHash: null }));
    mockPrisma.user.update.mockResolvedValue({});

    const result = await authService.setTransactionPin('user-1', { pin: '1234' });

    expect(result).toEqual({ set: true });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transactionPinHash: expect.any(String), transactionPinFailedAttempts: 0, transactionPinLockedUntil: null },
    });
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('rejette un changement sans fournir le PIN actuel', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ transactionPinHash: 'ancien-hash' }));

    await expect(
      authService.setTransactionPin('user-1', { pin: '567890' })
    ).rejects.toThrow('Code PIN actuel requis');

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('rejette un changement si le PIN actuel fourni est incorrect', async () => {
    const pinHash = await argon2.hash('1234');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: pinHash, transactionPinFailedAttempts: 0, transactionPinLockedUntil: null })
    );
    mockPrisma.user.update.mockResolvedValue({});

    await expect(
      authService.setTransactionPin('user-1', { currentPin: '0000', pin: '567890' })
    ).rejects.toThrow('Code PIN invalide');

    // Le hash du PIN n'a jamais été remplacé - seul le compteur de
    // tentatives (géré par verifyTransactionPin) a été mis à jour.
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transactionPinFailedAttempts: 1, transactionPinLockedUntil: null },
    });
  });

  test('change le PIN existant quand le PIN actuel fourni est correct, et notifie (alerte de sécurité)', async () => {
    const pinHash = await argon2.hash('1234');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: pinHash, transactionPinFailedAttempts: 0, transactionPinLockedUntil: null })
    );
    mockPrisma.user.update.mockResolvedValue({});

    const result = await authService.setTransactionPin('user-1', { currentPin: '1234', pin: '567890' });

    expect(result).toEqual({ set: true });
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'TRANSACTION_PIN_CHANGED' }),
      expect.any(String)
    );
  });
});

describe('verifyTransactionPin', () => {
  test('rejette si aucun PIN n\'a encore été défini', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ transactionPinHash: null }));

    await expect(authService.verifyTransactionPin('user-1', '1234')).rejects.toThrow('non défini');
  });

  test('rejette un PIN verrouillé après trop de tentatives, sans même vérifier le code', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: 'peu importe', transactionPinLockedUntil: new Date(Date.now() + 60000) })
    );

    await expect(authService.verifyTransactionPin('user-1', '1234')).rejects.toThrow('verrouillé');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('accepte un PIN correct et réinitialise le compteur de tentatives', async () => {
    const pinHash = await argon2.hash('1234');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: pinHash, transactionPinFailedAttempts: 2 })
    );
    mockPrisma.user.update.mockResolvedValue({});

    await authService.verifyTransactionPin('user-1', '1234');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transactionPinFailedAttempts: 0, transactionPinLockedUntil: null },
    });
  });

  test('incrémente les tentatives échouées sur un mauvais PIN, sans verrouiller avant le seuil', async () => {
    const pinHash = await argon2.hash('1234');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: pinHash, transactionPinFailedAttempts: 1, transactionPinLockedUntil: null })
    );
    mockPrisma.user.update.mockResolvedValue({});

    await expect(authService.verifyTransactionPin('user-1', '0000')).rejects.toThrow('Code PIN invalide');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transactionPinFailedAttempts: 2, transactionPinLockedUntil: null },
    });
  });

  test('verrouille le PIN et notifie dès que le seuil de tentatives est atteint', async () => {
    const pinHash = await argon2.hash('1234');
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ transactionPinHash: pinHash, transactionPinFailedAttempts: 4 })
    );
    mockPrisma.user.update.mockResolvedValue({});

    await expect(authService.verifyTransactionPin('user-1', '0000')).rejects.toThrow('Code PIN invalide');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { transactionPinFailedAttempts: 0, transactionPinLockedUntil: expect.any(Date) },
    });
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'TRANSACTION_PIN_LOCKED' }),
      expect.any(String)
    );
  });
});

describe('requestPasswordReset', () => {
  test('renvoie toujours "sent: true", même pour un numéro inexistant (anti-énumération)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const result = await authService.requestPasswordReset('+224699999999');
    expect(result).toEqual({ sent: true });
    expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
  });

  test('renvoie "sent: true" aussi pour un compte inactif, sans générer de code (même façade)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ status: 'PENDING_VERIFICATION' }));
    const result = await authService.requestPasswordReset('+224620000000');
    expect(result).toEqual({ sent: true });
    expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
  });

  test('génère bien un code pour un compte actif existant', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ status: 'ACTIVE' }));
    mockPrisma.otpCode.create.mockResolvedValue({});

    await authService.requestPasswordReset('+224620000000');

    expect(mockPrisma.otpCode.create.mock.calls[0][0].data.purpose).toBe('PASSWORD_RESET');
  });
});

describe('resetPassword', () => {
  test('rejette un code invalide', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:123456' });
    mockVerifyOtpCode.mockResolvedValue(false);

    await expect(
      authService.resetPassword({ phone: '+224620000000', code: '000000', newPassword: 'NouveauPassword1' })
    ).rejects.toThrow('Code invalide');

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('rejette si aucun code n\'est en attente (expiré ou jamais demandé)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue(null);

    await expect(
      authService.resetPassword({ phone: '+224620000000', code: '123456', newPassword: 'NouveauPassword1' })
    ).rejects.toThrow(/expiré ou introuvable/);
  });

  test('réussit : change le mot de passe, lève le verrouillage, et révoque les sessions', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      makeUser({ failedLoginAttempts: 4, lockedUntil: new Date(Date.now() + 60000) })
    );
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:123456' });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    const result = await authService.resetPassword({
      phone: '+224620000000',
      code: '123456',
      newPassword: 'NouveauPassword1',
    });

    expect(result).toEqual({ reset: true });

    // La récupération de compte doit aussi lever un éventuel verrouillage :
    // la personne vient de prouver son identité via un canal plus fort
    // (SMS) que le mot de passe qu'elle a oublié.
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
  });
});

describe('listActiveSessions', () => {
  test('ne remonte que les sessions actives (ni révoquées, ni expirées)', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([]);

    await authService.listActiveSessions('user-1');

    const call = mockPrisma.refreshToken.findMany.mock.calls[0][0];
    expect(call.where.userId).toBe('user-1');
    expect(call.where.revokedAt).toBeNull();
    expect(call.where.expiresAt.gt).toBeInstanceOf(Date);
  });

  test('ne renvoie jamais le hash du token, seulement les métadonnées de l\'appareil', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([]);
    await authService.listActiveSessions('user-1');
    const call = mockPrisma.refreshToken.findMany.mock.calls[0][0];
    expect(call.select).not.toHaveProperty('tokenHash');
  });
});

describe('revokeSession - propriété vérifiée', () => {
  test('rejette avec le même message qu\'une session inexistante si elle appartient à un autre utilisateur', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 's1', userId: 'autre-utilisateur', revokedAt: null });

    await expect(authService.revokeSession('user-1', 's1')).rejects.toThrow('introuvable');
    expect(mockPrisma.refreshToken.update).not.toHaveBeenCalled();
  });

  test('rejette si la session est déjà déconnectée', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', revokedAt: new Date() });

    await expect(authService.revokeSession('user-1', 's1')).rejects.toThrow(/déjà déconnectée/);
  });

  test('révoque bien la session du propriétaire réel et journalise l\'action', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', revokedAt: null });
    mockPrisma.refreshToken.update.mockResolvedValue({});

    await authService.revokeSession('user-1', 's1');

    expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { revokedAt: expect.any(Date) },
    });
    const auditCalls = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).toContain('SESSION_REVOKED');
  });

  test('révoquer UNE session ne touche jamais les autres (contrairement à la déconnexion globale)', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', revokedAt: null });
    mockPrisma.refreshToken.update.mockResolvedValue({});

    await authService.revokeSession('user-1', 's1');

    expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

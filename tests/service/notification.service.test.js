const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  notification: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockSendOtpBySms = jest.fn();
jest.mock('../../src/utils/otp', () => ({ sendOtpBySms: (...args) => mockSendOtpBySms(...args) }));

const notificationService = require('../../src/modules/notifications/notification.service');
const { registerPushToken, notifyUser, isValidExpoPushToken } = notificationService;

const originalFetch = global.fetch;

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    phone: '+224620000000',
    pushToken: null,
    notifyOnTransactions: true,
    notifyOnPaymentRequests: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  mockPrisma.notification.create.mockResolvedValue({});
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('isValidExpoPushToken', () => {
  test('accepte un vrai format de token Expo', () => {
    expect(isValidExpoPushToken('ExponentPushToken[abc123]')).toBe(true);
    expect(isValidExpoPushToken('ExpoPushToken[abc123]')).toBe(true);
  });

  test('rejette un format invalide', () => {
    expect(isValidExpoPushToken('n-importe-quoi')).toBe(false);
    expect(isValidExpoPushToken('')).toBe(false);
    expect(isValidExpoPushToken(null)).toBe(false);
  });
});

describe('registerPushToken', () => {
  test('rejette un token mal formé sans jamais toucher la base', async () => {
    await expect(registerPushToken('user-1', 'token-invalide')).rejects.toThrow('invalide');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('enregistre un token valide', async () => {
    mockPrisma.user.update.mockResolvedValue({});
    await registerPushToken('user-1', 'ExponentPushToken[abc123]');
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { pushToken: 'ExponentPushToken[abc123]' },
    });
  });
});

describe('notifyUser', () => {
  test('envoie uniquement le push si l\'utilisateur en a un configuré et que ça réussit (pas de SMS redondant)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ pushToken: 'ExponentPushToken[abc]' }));
    global.fetch.mockResolvedValue({ json: async () => ({ data: { status: 'ok' } }) });

    await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Titre', body: 'Corps' }, 'Texte SMS de repli');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockSendOtpBySms).not.toHaveBeenCalled();
  });

  test('retombe sur SMS si l\'utilisateur n\'a aucun token push', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());

    await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Titre', body: 'Corps' }, 'Texte SMS de repli');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSendOtpBySms).toHaveBeenCalledWith('+224620000000', 'Texte SMS de repli');
  });

  test('retombe sur SMS si l\'envoi push échoue au niveau réseau', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ pushToken: 'ExponentPushToken[abc]' }));
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Titre', body: 'Corps' }, 'Texte SMS de repli');

    expect(mockSendOtpBySms).toHaveBeenCalledWith('+224620000000', 'Texte SMS de repli');
  });

  test('efface le token et retombe sur SMS si Expo signale un appareil non enregistré (token périmé)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ pushToken: 'ExponentPushToken[perime]' }));
    global.fetch.mockResolvedValue({
      json: async () => ({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }),
    });

    await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Titre', body: 'Corps' }, 'Texte SMS de repli');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { pushToken: null } });
    expect(mockSendOtpBySms).toHaveBeenCalled();
  });

  test('ne plante jamais si l\'utilisateur est introuvable', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(
      notifyUser('inconnu', { type: 'DEPOSIT_RECEIVED', title: 'x', body: 'y' }, 'z')
    ).resolves.toBeUndefined();
  });

  test('n\'envoie aucun SMS si aucun texte de repli n\'est fourni et qu\'il n\'y a pas de token push', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'x', body: 'y' }, undefined);
    expect(mockSendOtpBySms).not.toHaveBeenCalled();
  });

  describe('journal (Notification persistée)', () => {
    test('crée toujours une Notification, même sans token push ni SMS de repli', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Dépôt reçu', body: 'Corps' });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', type: 'DEPOSIT_RECEIVED', title: 'Dépôt reçu', body: 'Corps', data: undefined },
      });
    });

    test("crée la Notification même si la catégorie est désactivée par l'utilisateur - seul le push/SMS est coupé", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ notifyOnTransactions: false }));

      await notifyUser('user-1', { type: 'DEPOSIT_RECEIVED', title: 'Dépôt reçu', body: 'Corps' }, 'SMS de repli');

      expect(mockPrisma.notification.create).toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockSendOtpBySms).not.toHaveBeenCalled();
    });
  });

  describe('préférences par catégorie', () => {
    test("n'envoie ni push ni SMS pour une opération sur le compte si notifyOnTransactions est désactivé", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        makeUser({ pushToken: 'ExponentPushToken[abc]', notifyOnTransactions: false })
      );

      await notifyUser('user-1', { type: 'PAYMENT_SENT', title: 'x', body: 'y' }, 'sms');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockSendOtpBySms).not.toHaveBeenCalled();
    });

    test("PAYMENT_REQUEST_PENDING suit notifyOnPaymentRequests, pas notifyOnTransactions", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        makeUser({ pushToken: 'ExponentPushToken[abc]', notifyOnTransactions: false, notifyOnPaymentRequests: true })
      );
      global.fetch.mockResolvedValue({ json: async () => ({ data: { status: 'ok' } }) });

      await notifyUser('user-1', { type: 'PAYMENT_REQUEST_PENDING', title: 'x', body: 'y' }, 'sms');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('coupe PAYMENT_REQUEST_PENDING quand notifyOnPaymentRequests est désactivé, même si notifyOnTransactions est actif', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        makeUser({ pushToken: 'ExponentPushToken[abc]', notifyOnTransactions: true, notifyOnPaymentRequests: false })
      );

      await notifyUser('user-1', { type: 'PAYMENT_REQUEST_PENDING', title: 'x', body: 'y' }, 'sms');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockSendOtpBySms).not.toHaveBeenCalled();
    });
  });
});

describe('listNotifications', () => {
  test('trie du plus récent au plus ancien', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    await notificationService.listNotifications('user-1');
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' }, orderBy: { createdAt: 'desc' } })
    );
  });

  test('plafonne à 100 même si un limit plus grand est demandé', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    await notificationService.listNotifications('user-1', { limit: 500 });
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});

describe('markAsRead - propriété vérifiée', () => {
  test("rejette avec le même message qu'une notification inexistante si elle appartient à un autre utilisateur", async () => {
    mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'autre-utilisateur' });
    await expect(notificationService.markAsRead('user-1', 'n1')).rejects.toThrow('introuvable');
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
  });

  test('marque comme lue pour le propriétaire réel', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'user-1' });
    mockPrisma.notification.update.mockResolvedValue({});

    await notificationService.markAsRead('user-1', 'n1');

    expect(mockPrisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { readAt: expect.any(Date) },
    });
  });
});

describe('markAllAsRead', () => {
  test('ne touche que les notifications non lues de cet utilisateur', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });
    await notificationService.markAllAsRead('user-1');
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});

describe('préférences', () => {
  test('updatePreferences ne modifie que les champs fournis', async () => {
    mockPrisma.user.update.mockResolvedValue({ notifyOnTransactions: false, notifyOnPaymentRequests: true });

    await notificationService.updatePreferences('user-1', { notifyOnTransactions: false });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { notifyOnTransactions: false },
      select: { notifyOnTransactions: true, notifyOnPaymentRequests: true },
    });
  });
});

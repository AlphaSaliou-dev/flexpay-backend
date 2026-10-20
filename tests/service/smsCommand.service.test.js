process.env.OTP_MAX_ATTEMPTS = '3';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockSendSmsText = jest.fn();
const mockVerifyOtpCode = jest.fn();
jest.mock('../../src/utils/otp', () => ({
  generateOtpCode: () => '483920',
  hashOtpCode: async (c) => `hashed:${c}`,
  verifyOtpCode: (...args) => mockVerifyOtpCode(...args),
  otpExpiryDate: () => new Date(Date.now() + 5 * 60000),
  sendSmsText: (...args) => mockSendSmsText(...args),
}));

const mockGetBalance = jest.fn();
const mockDeposit = jest.fn();
const mockWithdraw = jest.fn();
const mockTransfer = jest.fn();

jest.mock('../../src/modules/wallet/wallet.service', () => {
  class MockWalletError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    WalletError: MockWalletError,
    getBalance: (...args) => mockGetBalance(...args),
    deposit: (...args) => mockDeposit(...args),
    withdraw: (...args) => mockWithdraw(...args),
    transfer: (...args) => mockTransfer(...args),
  };
});

const { WalletError: FakeWalletError } = require('../../src/modules/wallet/wallet.service');

const smsCommandService = require('../../src/modules/smsCommands/smsCommand.service');

function makeUser(overrides = {}) {
  return { id: 'user-1', phone: '+224620000000', smsReference: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyOtpCode.mockResolvedValue(true);
});

describe('handleIncomingSms - numéro inconnu', () => {
  test('répond par SMS sans toucher au reste, pour un numéro sans compte', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await smsCommandService.handleIncomingSms({ from: '+224699999999', text: 'SOLDE 123456' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224699999999', expect.stringContaining("n'est associé à aucun compte"));
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});

describe('handleIncomingSms - OTP', () => {
  test('crée un OtpCode de purpose SMS_COMMAND et envoie le code par SMS', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.create.mockResolvedValue({});

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'OTP' });

    expect(mockPrisma.otpCode.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', purpose: 'SMS_COMMAND' }) })
    );
    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('483920'));
  });
});

describe('handleIncomingSms - SOLDE', () => {
  test('refuse sans code à la fin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'SOLDE' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('Code manquant'));
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  test('refuse si aucun OTP en attente', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue(null);

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'SOLDE 123456' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('expiré ou introuvable'));
  });

  test('refuse un mauvais code et incrémente les tentatives', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:483920' });
    mockVerifyOtpCode.mockResolvedValue(false);

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'SOLDE 000000' });

    expect(mockPrisma.otpCode.update).toHaveBeenCalledWith({ where: { id: 'otp-1' }, data: { attempts: { increment: 1 } } });
    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('Code invalide'));
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  test('renvoie le solde avec un code correct', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:483920' });
    mockGetBalance.mockResolvedValue({ balance: 50000, currency: 'GNF' });

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'SOLDE 483920' });

    expect(mockPrisma.otpCode.update).toHaveBeenCalledWith({ where: { id: 'otp-1' }, data: { consumedAt: expect.any(Date) } });
    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringMatching(/50[\s ]000/));
  });
});

describe('handleIncomingSms - DEPOT', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:483920' });
  });

  test('rejette un moyen de paiement invalide', async () => {
    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'DEPOT 50000 wave 483920' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('Moyen invalide'));
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  test('appelle wallet.deposit avec une idempotencyKey dérivée du messageId', async () => {
    mockDeposit.mockResolvedValue({ id: 'tx-1' });

    await smsCommandService.handleIncomingSms({
      from: '+224620000000',
      text: 'DEPOT 50000 orange_money 483920',
      messageId: 'nimba-msg-42',
    });

    expect(mockDeposit).toHaveBeenCalledWith('user-1', {
      amount: 50000,
      idempotencyKey: 'sms:nimba-msg-42:deposit',
      provider: 'orange_money',
    });
    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('dépôt'));
  });

  test('relaye le message d\'une WalletError (ex: fournisseur externe en échec) par SMS', async () => {
    mockDeposit.mockRejectedValue(new FakeWalletError('Le dépôt via orange_money a échoué, réessayez', 402));

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'DEPOT 50000 orange_money 483920' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('a échoué'));
  });
});

describe('handleIncomingSms - ENVOI', () => {
  beforeEach(() => {
    mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', attempts: 0, codeHash: 'hashed:483920' });
  });

  test('résout une référence opaque à 6 chiffres vers le vrai numéro avant de transférer', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser()) // l'expéditeur, identifié par son numéro
      .mockResolvedValueOnce(makeUser({ id: 'user-2', phone: '+224611111111', smsReference: '773311' })); // résolution de la référence
    mockTransfer.mockResolvedValue({ id: 'tx-2' });

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'ENVOI 20000 773311 483920' });

    expect(mockTransfer).toHaveBeenCalledWith('user-1', expect.objectContaining({ toPhone: '+224611111111', amount: 20000 }));
  });

  test('accepte un numéro en clair comme repli pour un premier contact', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());
    mockTransfer.mockResolvedValue({ id: 'tx-3' });

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'ENVOI 20000 +224611111111 483920' });

    expect(mockTransfer).toHaveBeenCalledWith('user-1', expect.objectContaining({ toPhone: '+224611111111' }));
  });

  test('rejette une référence inconnue sans jamais appeler transfer', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(null);

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'ENVOI 20000 999999 483920' });

    expect(mockTransfer).not.toHaveBeenCalled();
    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('inconnue'));
  });
});

describe('handleIncomingSms - commande inconnue', () => {
  test('répond avec le rappel des commandes disponibles', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser());

    await smsCommandService.handleIncomingSms({ from: '+224620000000', text: 'BONJOUR' });

    expect(mockSendSmsText).toHaveBeenCalledWith('+224620000000', expect.stringContaining('commande inconnue'));
  });
});

describe('getOrCreateSmsReference', () => {
  test('renvoie la référence existante sans rien écrire', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(makeUser({ smsReference: '112233' }));

    const ref = await smsCommandService.getOrCreateSmsReference('user-1');

    expect(ref).toBe('112233');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('en génère une nouvelle et la persiste si absente', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser({ smsReference: null })) // l'utilisateur lui-même
      .mockResolvedValueOnce(null); // aucune collision trouvée
    mockPrisma.user.update.mockImplementation(({ data }) => Promise.resolve({ smsReference: data.smsReference }));

    const ref = await smsCommandService.getOrCreateSmsReference('user-1');

    expect(ref).toMatch(/^\d{6}$/);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { smsReference: ref } });
  });
});

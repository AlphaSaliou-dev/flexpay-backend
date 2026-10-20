// On mocke entièrement notre module config/db.js (pas @prisma/client
// directement) : c'est le point d'entrée unique vers la base utilisé par
// tous les services. Ça permet de tester la LOGIQUE MÉTIER (le calcul,
// les conditions, les erreurs) indépendamment de toute vraie base de
// données - rapide, déterministe, et exécutable partout sans PostgreSQL.

const mockTx = {
  $queryRaw: jest.fn().mockResolvedValue([]),
  wallet: { findUnique: jest.fn(), update: jest.fn() },
  transaction: { create: jest.fn() },
  ledgerEntry: { create: jest.fn() },
  user: { findUnique: jest.fn() },
};

const mockPrisma = {
  $transaction: jest.fn((fn) => fn(mockTx)),
  wallet: { findUnique: jest.fn(), create: jest.fn() },
  transaction: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  ledgerEntry: { aggregate: jest.fn() },
};

jest.mock('../../src/config/db', () => mockPrisma);
jest.mock('../../src/modules/wallet/limits.guard', () => ({ assertWithinLimits: jest.fn() }));

const mockNotifyUser = jest.fn();
jest.mock('../../src/modules/notifications/notification.service', () => ({
  notifyUser: (...args) => mockNotifyUser(...args),
}));

const mockCollect = jest.fn();
const mockPayout = jest.fn();
jest.mock('../../src/modules/externalPayments/externalPayments.service', () => ({
  collect: (...args) => mockCollect(...args),
  payout: (...args) => mockPayout(...args),
}));

const walletService = require('../../src/modules/wallet/wallet.service');

function makeWallet(overrides = {}) {
  return {
    id: 'wallet-1',
    ownerType: 'USER',
    userId: 'user-1',
    balance: 0,
    frozen: false,
    ...overrides,
  };
}

beforeEach(() => {
  // resetAllMocks (pas seulement clearAllMocks) : les valeurs mises en
  // file via mockResolvedValueOnce dans un test qui retourne plus tôt que
  // prévu (ex. idempotence) restent sinon en attente et sont consommées
  // par erreur par le test suivant.
  jest.resetAllMocks();
  mockPrisma.$transaction.mockImplementation((fn) => fn(mockTx));
  mockTx.$queryRaw.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue({ phone: '+224620222222' });
  mockCollect.mockResolvedValue({ status: 'COMPLETED', providerReference: 'MOCK-TEST-REF' });
  mockPayout.mockResolvedValue({ status: 'COMPLETED', providerReference: 'MOCK-PAYOUT-TEST-REF' });
});

describe('moveFunds', () => {
  test('rejette un montant négatif ou nul avant même de toucher la base', async () => {
    await expect(
      walletService.moveFunds({ fromWalletId: 'a', toWalletId: 'b', amount: 0, type: 'TRANSFER', idempotencyKey: 'k1' })
    ).rejects.toThrow('Montant invalide');

    await expect(
      walletService.moveFunds({ fromWalletId: 'a', toWalletId: 'b', amount: -100, type: 'TRANSFER', idempotencyKey: 'k2' })
    ).rejects.toThrow('Montant invalide');

    // Aucune écriture n'a dû être tentée pour un montant invalide.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('idempotence : une clé déjà traitée renvoie la transaction existante sans rejouer le mouvement', async () => {
    const existing = { id: 'tx-existing', status: 'COMPLETED' };
    mockPrisma.transaction.findUnique.mockResolvedValue(existing);

    const result = await walletService.moveFunds({
      fromWalletId: 'a', toWalletId: 'b', amount: 1000, type: 'TRANSFER', idempotencyKey: 'already-used',
    });

    expect(result).toBe(existing);
    // Le point le plus important : aucune écriture supplémentaire ne doit
    // avoir lieu - sinon l'idempotence ne protège de rien.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('rejette si le wallet source a un solde insuffisant', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'from', balance: 500 }))
      .mockResolvedValueOnce(makeWallet({ id: 'to', balance: 0 }));

    await expect(
      walletService.moveFunds({ fromWalletId: 'from', toWalletId: 'to', amount: 1000, type: 'TRANSFER', idempotencyKey: 'k3' })
    ).rejects.toThrow('Solde insuffisant');

    expect(mockTx.transaction.create).not.toHaveBeenCalled();
  });

  test('rejette si un des deux wallets est gelé', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'from', balance: 5000, frozen: true }))
      .mockResolvedValueOnce(makeWallet({ id: 'to', balance: 0 }));

    await expect(
      walletService.moveFunds({ fromWalletId: 'from', toWalletId: 'to', amount: 1000, type: 'TRANSFER', idempotencyKey: 'k4' })
    ).rejects.toThrow('Wallet gelé');
  });

  test('rejette si le crédit ferait dépasser le plafond de solde du destinataire', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'from', balance: 50_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'to', balance: 14_500_000 })); // Tier 0 : max 15M
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_0' } });

    await expect(
      walletService.moveFunds({ fromWalletId: 'from', toWalletId: 'to', amount: 1_000_000, type: 'TRANSFER', idempotencyKey: 'k5' })
    ).rejects.toThrow(/plafond de solde/);
  });

  test('un mouvement valide crée exactement 2 écritures (un débit, un crédit) qui s\'équilibrent', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'from', balance: 5000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'to', balance: 0 }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-new' });

    await walletService.moveFunds({
      fromWalletId: 'from', toWalletId: 'to', amount: 2000, type: 'TRANSFER', idempotencyKey: 'k6', initiatedByUserId: 'user-1',
    });

    expect(mockTx.ledgerEntry.create).toHaveBeenCalledTimes(2);

    const [debitCall, creditCall] = mockTx.ledgerEntry.create.mock.calls;
    expect(debitCall[0].data.direction).toBe('DEBIT');
    expect(debitCall[0].data.amount).toBe(2000);
    expect(debitCall[0].data.balanceAfter).toBe(3000); // 5000 - 2000

    expect(creditCall[0].data.direction).toBe('CREDIT');
    expect(creditCall[0].data.amount).toBe(2000);
    expect(creditCall[0].data.balanceAfter).toBe(2000); // 0 + 2000

    // La somme des deux écritures s'équilibre toujours à zéro - le
    // fondement même du système en partie double.
    const net = (creditCall[0].data.direction === 'CREDIT' ? 1 : -1) * creditCall[0].data.amount
      + (debitCall[0].data.direction === 'DEBIT' ? -1 : 1) * debitCall[0].data.amount;
    expect(net).toBe(0);
  });

  test('un wallet SYSTEM (contrepartie externe) n\'est jamais soumis au contrôle de solde suffisant', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'from', ownerType: 'SYSTEM', userId: null, balance: 0 }))
      .mockResolvedValueOnce(makeWallet({ id: 'to', balance: 0 }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-deposit' });

    // Un dépôt fait "sortir" de l'argent d'un wallet SYSTEM dont le solde
    // affiché est 0 - normalement interdit pour un wallet USER (solde
    // insuffisant), mais légitime pour une contrepartie externe comme
    // Orange Money : le contrôle de solde suffisant ne s'applique qu'aux
    // wallets appartenant réellement à un utilisateur.
    await expect(
      walletService.moveFunds({ fromWalletId: 'from', toWalletId: 'to', amount: 10_000_000, type: 'DEPOSIT', idempotencyKey: 'k7' })
    ).resolves.toBeDefined();
  });
});

describe('deposit - notifications', () => {
  test('notifie le titulaire du dépôt reçu', async () => {
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet' })) // getOrCreateUserWallet
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null })); // getOrCreateSystemWallet
    mockPrisma.transaction.findUnique.mockResolvedValue(null); // ni vu par le garde anti-doublon, ni par moveFunds
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet' }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-deposit-1' });

    await walletService.deposit('user-1', { amount: 500000, idempotencyKey: 'dep-1', provider: 'orange_money' });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'DEPOSIT_RECEIVED', data: { transactionId: 'tx-deposit-1' } })
    );
  });

  test('ne renotifie jamais un dépôt déjà traité (retry réseau, même idempotencyKey)', async () => {
    const existing = { id: 'tx-deposit-existant' };
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet' }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }));
    // Vu comme déjà traité par le garde AVANT moveFunds, ET par moveFunds lui-même.
    mockPrisma.transaction.findUnique.mockResolvedValue(existing);

    await walletService.deposit('user-1', { amount: 500000, idempotencyKey: 'dep-1', provider: 'orange_money' });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

// Un dépôt ne doit jamais créditer sur simple déclaration du client : le
// serveur doit lui-même interroger le fournisseur externe (collect()) et
// n'utiliser QUE la référence qu'il renvoie. Voir le pré-existant trouvé
// dans FlexPay_Mode_Hors_Ligne_SMS.md.
describe('deposit - vérification auprès du fournisseur externe', () => {
  test('interroge collect() avec le numéro réel du compte, jamais une référence fournie par le client', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ phone: '+224620333333' });
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet' }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet' }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-deposit-2' });

    await walletService.deposit('user-1', { amount: 50000, idempotencyKey: 'dep-2', provider: 'orange_money' });

    expect(mockCollect).toHaveBeenCalledWith({ phone: '+224620333333', amount: 50000, provider: 'orange_money' });
  });

  test('rejette le dépôt si le fournisseur ne confirme pas (collect() renvoie autre chose que COMPLETED)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockCollect.mockResolvedValue({ status: 'FAILED' });

    await expect(
      walletService.deposit('user-1', { amount: 50000, idempotencyKey: 'dep-3', provider: 'mtn_momo' })
    ).rejects.toThrow('échoué');

    expect(mockTx.transaction.create).not.toHaveBeenCalled();
  });

  test('rejette un dépôt "bank" sans même appeler le fournisseur (pas encore disponible)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);

    await expect(
      walletService.deposit('user-1', { amount: 50000, idempotencyKey: 'dep-4', provider: 'bank' })
    ).rejects.toThrow('pas encore disponibles');

    expect(mockCollect).not.toHaveBeenCalled();
  });

  test('un retry réseau (idempotencyKey déjà traité) ne réinterroge jamais le fournisseur une seconde fois', async () => {
    const existing = { id: 'tx-deposit-existant' };
    mockPrisma.transaction.findUnique.mockResolvedValue(existing);

    const result = await walletService.deposit('user-1', { amount: 50000, idempotencyKey: 'dep-1', provider: 'orange_money' });

    expect(result).toBe(existing);
    expect(mockCollect).not.toHaveBeenCalled();
  });
});

describe('withdraw - notifications', () => {
  test('notifie le titulaire du retrait effectué', async () => {
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-withdraw-1' });

    await walletService.withdraw('user-1', { amount: 200000, idempotencyKey: 'wd-1', provider: 'orange_money' });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'WITHDRAWAL_COMPLETED', data: { transactionId: 'tx-withdraw-1' } })
    );
  });

  test('ne renotifie jamais un retrait déjà traité', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue({ id: 'tx-existante' });

    await walletService.withdraw('user-1', { amount: 200000, idempotencyKey: 'wd-1', provider: 'orange_money' });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

// Même principe que pour deposit() : l'argent sortant réel ne doit jamais
// être considéré "parti" sans confirmation du fournisseur, et jamais tant
// que le solde réel n'est pas vérifié suffisant.
describe('withdraw - vérification auprès du fournisseur externe', () => {
  test('interroge payout() avec le numéro réel du compte avant de débiter quoi que ce soit', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockPrisma.user.findUnique.mockResolvedValue({ phone: '+224620444444' });
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-withdraw-2' });

    await walletService.withdraw('user-1', { amount: 75000, idempotencyKey: 'wd-2', provider: 'mtn_momo' });

    expect(mockPayout).toHaveBeenCalledWith({ phone: '+224620444444', amount: 75000, provider: 'mtn_momo' });
  });

  test('rejette le retrait si le fournisseur ne confirme pas le versement, sans débiter', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique.mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }));
    mockPayout.mockResolvedValue({ status: 'FAILED' });

    await expect(
      walletService.withdraw('user-1', { amount: 75000, idempotencyKey: 'wd-3', provider: 'orange_money' })
    ).rejects.toThrow('échoué');

    expect(mockTx.transaction.create).not.toHaveBeenCalled();
  });

  test('rejette un retrait "bank" sans même appeler le fournisseur (pas encore disponible)', async () => {
    await expect(
      walletService.withdraw('user-1', { amount: 75000, idempotencyKey: 'wd-4', provider: 'bank' })
    ).rejects.toThrow('pas encore disponibles');

    expect(mockPayout).not.toHaveBeenCalled();
  });

  test('refuse un solde insuffisant AVANT de contacter le fournisseur (pas de versement réel pour de l\'argent qu\'on n\'a pas)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique.mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 10000 }));

    await expect(
      walletService.withdraw('user-1', { amount: 75000, idempotencyKey: 'wd-5', provider: 'orange_money' })
    ).rejects.toThrow('Solde insuffisant');

    expect(mockPayout).not.toHaveBeenCalled();
  });

  test('un retry réseau (idempotencyKey déjà traité) ne réinterroge jamais le fournisseur', async () => {
    const existing = { id: 'tx-withdraw-existant' };
    mockPrisma.transaction.findUnique.mockResolvedValue(existing);

    const result = await walletService.withdraw('user-1', { amount: 75000, idempotencyKey: 'wd-1', provider: 'orange_money' });

    expect(result).toBe(existing);
    expect(mockPayout).not.toHaveBeenCalled();
  });

  test('prélève 1% de commission en plus du montant demandé, dans un mouvement FEE séparé', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.transaction.create
      .mockResolvedValueOnce({ id: 'tx-withdraw-main' })
      .mockResolvedValueOnce({ id: 'tx-withdraw-fee' });

    await walletService.withdraw('user-1', { amount: 100000, idempotencyKey: 'wd-6', provider: 'orange_money' });

    // Mouvement principal : exactement le montant demandé (l'utilisateur
    // reçoit 100 000 chez l'opérateur, pas moins).
    expect(mockTx.wallet.update).toHaveBeenCalledWith({ where: { id: 'user-wallet' }, data: { balance: 900000 } });
    // Mouvement FEE séparé : 1% de 100 000 = 1 000, avec sa propre
    // idempotencyKey dérivée (":fee") pour ne jamais se confondre avec
    // le mouvement principal.
    expect(mockTx.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: 'wd-6:fee', amount: 1000, type: 'FEE' }) })
    );
  });

  test('le solde requis inclut la commission (refuse un solde juste suffisant pour le montant seul)', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    // 100 700 GNF suffit pour les 100 000 demandés mais pas pour les
    // 100 000 + 1% (1 000) de commission.
    mockPrisma.wallet.findUnique.mockResolvedValueOnce(makeWallet({ id: 'user-wallet', balance: 100700 }));

    await expect(
      walletService.withdraw('user-1', { amount: 100000, idempotencyKey: 'wd-7', provider: 'orange_money' })
    ).rejects.toThrow('Solde insuffisant');

    expect(mockPayout).not.toHaveBeenCalled();
  });
});

describe('transfer - notifications', () => {
  test('notifie à la fois l\'expéditeur (envoyé) et le destinataire (reçu)', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'user-2', fullName: 'Mariama Diallo', phone: '+224621000000', status: 'ACTIVE' }) // destinataire par téléphone
      .mockResolvedValueOnce({ id: 'user-1', fullName: 'Aïssatou Camara', phone: '+224620000000' }); // fromUser
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1' }))
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-2', userId: 'user-2' }));
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-2', userId: 'user-2' }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-transfer-1' });

    await walletService.transfer('user-1', { toPhone: '+224621000000', amount: 120000, idempotencyKey: 'tr-1' });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'TRANSFER_SENT' })
    );
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({ type: 'TRANSFER_RECEIVED' }),
      expect.any(String)
    );
  });

  test('ne renotifie ni l\'un ni l\'autre pour un transfert déjà traité', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-2', fullName: 'Mariama Diallo', phone: '+224621000000', status: 'ACTIVE' });
    mockPrisma.transaction.findUnique.mockResolvedValue({ id: 'tx-existante' });

    const result = await walletService.transfer('user-1', { toPhone: '+224621000000', amount: 120000, idempotencyKey: 'tr-1' });

    expect(result).toEqual({ id: 'tx-existante' });
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });
});

// Repli vers un opérateur mobile money externe quand le destinataire n'a
// pas (ou plus) de compte FlexPay actif - même principe que le paiement
// en masse (bulkPayout.service.js), pour qu'un envoi simple ne soit
// jamais bloqué juste parce que l'autre personne n'a pas encore FlexPay.
describe('transfer - repli externe (destinataire sans compte FlexPay actif)', () => {
  test('rejette toujours sans repli choisi (comportement historique inchangé)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      walletService.transfer('user-1', { toPhone: '+224629999999', amount: 50000, idempotencyKey: 'tr-2' })
    ).rejects.toThrow('Destinataire introuvable');

    expect(mockPayout).not.toHaveBeenCalled();
  });

  test('part via l\'opérateur choisi quand un repli est fourni, sans jamais appeler moveFunds entre comptes FlexPay', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // aucun compte FlexPay pour ce numéro
      .mockResolvedValueOnce({ id: 'user-1', fullName: 'Aïssatou Camara', phone: '+224620000000' }); // fromUser
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'ext-wallet', ownerType: 'SYSTEM', userId: null }))
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'fees-wallet', ownerType: 'SYSTEM', userId: null }));
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-transfer-external' });

    await walletService.transfer('user-1', {
      toPhone: '+224629999999',
      amount: 50000,
      idempotencyKey: 'tr-3',
      externalPayoutMethod: 'orange_money',
    });

    expect(mockPayout).toHaveBeenCalledWith({ phone: '+224629999999', amount: 50000, provider: 'orange_money' });
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'TRANSFER_SENT', body: expect.stringContaining('Orange Money') })
    );
    // Un seul destinataire ici est réel (le numéro externe n'a pas de
    // compte FlexPay) - jamais de notification "reçu" pour quelqu'un qui
    // n'existe pas côté FlexPay.
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);

    // 0,5% de 50 000 = 250 GNF, prélevés dans un mouvement FEE séparé.
    expect(mockTx.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: 'tr-3:fee', amount: 250, type: 'FEE' }) })
    );
    expect(mockNotifyUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ body: expect.stringContaining('250') })
    );
  });

  test('un transfert FlexPay-vers-FlexPay reste 100% gratuit, aucun mouvement FEE', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'user-2', fullName: 'Mariama Diallo', phone: '+224621000000', status: 'ACTIVE' })
      .mockResolvedValueOnce({ id: 'user-1', fullName: 'Aïssatou Camara', phone: '+224620000000' });
    mockPrisma.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1' }))
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-2', userId: 'user-2' }));
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockTx.wallet.findUnique
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }))
      .mockResolvedValueOnce(makeWallet({ id: 'wallet-2', userId: 'user-2' }));
    mockTx.user.findUnique.mockResolvedValue({ accountType: 'INDIVIDUAL', kycProfile: { tier: 'TIER_2' } });
    mockTx.transaction.create.mockResolvedValue({ id: 'tx-transfer-internal' });

    await walletService.transfer('user-1', { toPhone: '+224621000000', amount: 120000, idempotencyKey: 'tr-5' });

    // Un seul mouvement créé au total (le transfert lui-même) - aucun
    // second mouvement FEE, contrairement au repli externe.
    expect(mockTx.transaction.create).toHaveBeenCalledTimes(1);
  });

  test('rejette si le fournisseur ne confirme pas l\'envoi externe, sans débiter', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    mockPrisma.wallet.findUnique.mockResolvedValueOnce(makeWallet({ id: 'wallet-1', userId: 'user-1', balance: 1_000_000 }));
    mockPayout.mockResolvedValue({ status: 'FAILED' });

    await expect(
      walletService.transfer('user-1', {
        toPhone: '+224629999999',
        amount: 50000,
        idempotencyKey: 'tr-4',
        externalPayoutMethod: 'mtn_momo',
      })
    ).rejects.toThrow('a échoué');

    expect(mockTx.transaction.create).not.toHaveBeenCalled();
  });
});

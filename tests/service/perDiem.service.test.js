const mockPrisma = {
  user: { findUnique: jest.fn() },
  perDiemSchedule: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  beneficiaryGroup: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const mockCreateBulkPayout = jest.fn();
jest.mock('../../src/modules/bulkPayout/bulkPayout.service', () => ({
  createBulkPayout: (...args) => mockCreateBulkPayout(...args),
}));

const perDiemService = require('../../src/modules/perDiem/perDiem.service');

function makeSchedule(overrides = {}) {
  return {
    id: 'sched-1',
    businessUserId: 'biz-1',
    enabled: true,
    groupId: 'group-1',
    frequency: 'DAILY',
    timeOfDay: '07:00',
    dayOfWeek: null,
    dayOfMonth: null,
    externalPayoutMethod: null,
    reference: 'Per diem',
    lastRunAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isDue - pure, sans accès base', () => {
  test('pas due si désactivée, même si l\'heure est passée', () => {
    const schedule = makeSchedule({ enabled: false });
    const now = new Date('2026-10-10T08:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('pas due si aucune liste de bénéficiaires configurée', () => {
    const schedule = makeSchedule({ groupId: null });
    const now = new Date('2026-10-10T08:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('DAILY : pas due avant l\'heure programmée', () => {
    const schedule = makeSchedule({ timeOfDay: '07:00' });
    const now = new Date('2026-10-10T06:59:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('DAILY : due pile à l\'heure programmée si jamais exécutée', () => {
    const schedule = makeSchedule({ timeOfDay: '07:00' });
    const now = new Date('2026-10-10T07:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(true);
  });

  test('DAILY : due après l\'heure programmée si jamais exécutée', () => {
    const schedule = makeSchedule({ timeOfDay: '07:00' });
    const now = new Date('2026-10-10T09:30:00');
    expect(perDiemService.isDue(schedule, now)).toBe(true);
  });

  test('DAILY : pas due une deuxième fois le même jour après le créneau', () => {
    const schedule = makeSchedule({ timeOfDay: '07:00', lastRunAt: new Date('2026-10-10T07:00:05') });
    const now = new Date('2026-10-10T18:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('DAILY : à nouveau due le lendemain, même si exécutée la veille', () => {
    const schedule = makeSchedule({ timeOfDay: '07:00', lastRunAt: new Date('2026-10-10T07:00:05') });
    const now = new Date('2026-10-11T07:05:00');
    expect(perDiemService.isDue(schedule, now)).toBe(true);
  });

  test('WEEKLY : pas due un jour différent du jour choisi', () => {
    // 2026-10-10 est un samedi (6) - jour choisi : lundi (1)
    const schedule = makeSchedule({ frequency: 'WEEKLY', dayOfWeek: 1, timeOfDay: '07:00' });
    const now = new Date('2026-10-10T08:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('WEEKLY : due le bon jour, à la bonne heure', () => {
    // 2026-10-12 est un lundi
    const schedule = makeSchedule({ frequency: 'WEEKLY', dayOfWeek: 1, timeOfDay: '07:00' });
    const now = new Date('2026-10-12T07:30:00');
    expect(perDiemService.isDue(schedule, now)).toBe(true);
  });

  test('MONTHLY : pas due un autre jour du mois', () => {
    const schedule = makeSchedule({ frequency: 'MONTHLY', dayOfMonth: 1, timeOfDay: '07:00' });
    const now = new Date('2026-10-15T08:00:00');
    expect(perDiemService.isDue(schedule, now)).toBe(false);
  });

  test('MONTHLY : due le bon jour du mois, à la bonne heure', () => {
    const schedule = makeSchedule({ frequency: 'MONTHLY', dayOfMonth: 15, timeOfDay: '07:00' });
    const now = new Date('2026-10-15T07:01:00');
    expect(perDiemService.isDue(schedule, now)).toBe(true);
  });
});

describe('upsertSchedule - réservé aux comptes Entreprise', () => {
  test('rejette un compte MERCHANT (même règle que le paiement en masse manuel)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'merchant-1', accountType: 'MERCHANT' });

    await expect(
      perDiemService.upsertSchedule('merchant-1', { enabled: true, frequency: 'DAILY', timeOfDay: '07:00' })
    ).rejects.toThrow(/réservé aux comptes Entreprise/);
    expect(mockPrisma.perDiemSchedule.upsert).not.toHaveBeenCalled();
  });

  test('rejette un compte INDIVIDUAL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', accountType: 'INDIVIDUAL' });

    await expect(
      perDiemService.upsertSchedule('user-1', { enabled: true, frequency: 'DAILY', timeOfDay: '07:00' })
    ).rejects.toThrow(/réservé aux comptes Entreprise/);
  });

  test('rejette une liste de bénéficiaires appartenant à une autre entreprise', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'group-1', businessUserId: 'autre-entreprise' });

    await expect(
      perDiemService.upsertSchedule('biz-1', { enabled: true, groupId: 'group-1', frequency: 'DAILY', timeOfDay: '07:00' })
    ).rejects.toThrow(/introuvable/);
  });

  test('accepte un compte BUSINESS avec une liste qui lui appartient', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({ id: 'group-1', businessUserId: 'biz-1' });
    mockPrisma.perDiemSchedule.upsert.mockResolvedValue({ id: 'sched-1' });

    await expect(
      perDiemService.upsertSchedule('biz-1', { enabled: true, groupId: 'group-1', frequency: 'DAILY', timeOfDay: '07:00' })
    ).resolves.toBeDefined();
  });

  test('efface dayOfWeek/dayOfMonth non pertinents pour la fréquence choisie', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.upsert.mockResolvedValue({ id: 'sched-1' });

    await perDiemService.upsertSchedule('biz-1', {
      enabled: true,
      frequency: 'DAILY',
      timeOfDay: '07:00',
      dayOfWeek: 3,
      dayOfMonth: 15,
    });

    const call = mockPrisma.perDiemSchedule.upsert.mock.calls[0][0];
    expect(call.create.dayOfWeek).toBeNull();
    expect(call.create.dayOfMonth).toBeNull();
  });
});

describe('runNow - déclenchement manuel de test', () => {
  test('rejette si aucune liste de bénéficiaires n\'est configurée', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.findUnique.mockResolvedValue(makeSchedule({ groupId: null }));

    await expect(perDiemService.runNow('biz-1')).rejects.toThrow(/Configurez une liste/);
    expect(mockCreateBulkPayout).not.toHaveBeenCalled();
  });

  test('ignore les membres sans montant par défaut (personne pour répondre à 7h du matin)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.findUnique.mockResolvedValue(makeSchedule());
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      members: [
        { phone: '+224620000001', defaultAmount: 20000, defaultReference: null },
        { phone: '+224620000002', defaultAmount: null, defaultReference: null },
      ],
    });
    mockCreateBulkPayout.mockResolvedValue({ id: 'bp-1', successCount: 1, failedCount: 0 });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    await perDiemService.runNow('biz-1');

    expect(mockCreateBulkPayout).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({ items: [{ phone: '+224620000001', amount: 20000, reference: 'Per diem' }] })
    );
  });

  test('ne crée aucun lot si aucun membre n\'a de montant défini', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.findUnique.mockResolvedValue(makeSchedule());
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      members: [{ phone: '+224620000001', defaultAmount: null, defaultReference: null }],
    });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    await perDiemService.runNow('biz-1');

    expect(mockCreateBulkPayout).not.toHaveBeenCalled();
    const updateCall = mockPrisma.perDiemSchedule.update.mock.calls[0][0];
    expect(updateCall.data.lastRunStatus).toMatch(/Aucun membre/);
  });

  test('relaie externalPayoutMethod au moteur de paiement en masse', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.findUnique.mockResolvedValue(makeSchedule({ externalPayoutMethod: 'orange_money' }));
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      members: [{ phone: '+224620000001', defaultAmount: 20000, defaultReference: null }],
    });
    mockCreateBulkPayout.mockResolvedValue({ id: 'bp-1', successCount: 1, failedCount: 0 });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    await perDiemService.runNow('biz-1');

    expect(mockCreateBulkPayout).toHaveBeenCalledWith('biz-1', expect.objectContaining({ externalPayoutMethod: 'orange_money' }));
  });

  test('enregistre le résultat (succès/échecs) après exécution', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'biz-1', accountType: 'BUSINESS' });
    mockPrisma.perDiemSchedule.findUnique.mockResolvedValue(makeSchedule());
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      members: [{ phone: '+224620000001', defaultAmount: 20000, defaultReference: null }],
    });
    mockCreateBulkPayout.mockResolvedValue({ id: 'bp-1', successCount: 1, failedCount: 0 });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    await perDiemService.runNow('biz-1');

    const updateCall = mockPrisma.perDiemSchedule.update.mock.calls[0][0];
    expect(updateCall.data.lastRunStatus).toBe('1 réussi(s), 0 échoué(s)');
    expect(updateCall.data.lastRunBulkPayoutId).toBe('bp-1');
    expect(updateCall.data.lastRunAt).toBeInstanceOf(Date);
  });
});

describe('runDueSchedules - utilisé par le script cron', () => {
  test('n\'exécute que les schedules dus, ignore les autres', async () => {
    const dueSchedule = makeSchedule({ id: 'sched-due', businessUserId: 'biz-due', timeOfDay: '07:00' });
    const notDueSchedule = makeSchedule({ id: 'sched-not-due', businessUserId: 'biz-not-due', timeOfDay: '23:59' });
    mockPrisma.perDiemSchedule.findMany.mockResolvedValue([dueSchedule, notDueSchedule]);
    mockPrisma.beneficiaryGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      members: [{ phone: '+224620000001', defaultAmount: 20000, defaultReference: null }],
    });
    mockCreateBulkPayout.mockResolvedValue({ id: 'bp-1', successCount: 1, failedCount: 0 });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    const now = new Date('2026-10-10T08:00:00');
    const results = await perDiemService.runDueSchedules(now);

    expect(results).toHaveLength(1);
    expect(results[0].businessUserId).toBe('biz-due');
  });

  test('une automatisation en échec ne bloque pas les suivantes', async () => {
    const schedule1 = makeSchedule({ id: 'sched-1', businessUserId: 'biz-1', timeOfDay: '07:00', groupId: 'group-manquant' });
    const schedule2 = makeSchedule({ id: 'sched-2', businessUserId: 'biz-2', timeOfDay: '07:00', groupId: 'group-1' });
    mockPrisma.perDiemSchedule.findMany.mockResolvedValue([schedule1, schedule2]);
    mockPrisma.beneficiaryGroup.findUnique
      .mockResolvedValueOnce(null) // group-manquant
      .mockResolvedValueOnce({ id: 'group-1', members: [{ phone: '+224620000001', defaultAmount: 20000, defaultReference: null }] });
    mockCreateBulkPayout.mockResolvedValue({ id: 'bp-2', successCount: 1, failedCount: 0 });
    mockPrisma.perDiemSchedule.update.mockResolvedValue({});

    const now = new Date('2026-10-10T08:00:00');
    const results = await perDiemService.runDueSchedules(now);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.businessUserId === 'biz-2').ok).toBe(true);
  });
});

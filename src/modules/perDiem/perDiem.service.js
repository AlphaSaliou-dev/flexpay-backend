const crypto = require('crypto');
const prisma = require('../../config/db');
const bulkPayoutService = require('../bulkPayout/bulkPayout.service');

class PerDiemError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Réservé à l'Entreprise, jamais au Marchand : exactement la même
// restriction que le paiement en masse manuel (voir createBulkPayout dans
// bulkPayout.service.js) puisque le per diem n'est qu'une programmation
// automatique de ce même mécanisme - pas un flux d'argent différent, donc
// pas de raison d'avoir une règle d'éligibilité différente.
async function assertEligibleBusiness(businessUserId) {
  const user = await prisma.user.findUnique({ where: { id: businessUserId } });
  if (!user || user.accountType !== 'BUSINESS') {
    throw new PerDiemError('Le paiement automatique du personnel est réservé aux comptes Entreprise', 403);
  }
  return user;
}

async function getSchedule(businessUserId) {
  await assertEligibleBusiness(businessUserId);
  return prisma.perDiemSchedule.findUnique({
    where: { businessUserId },
    include: { group: { select: { id: true, name: true } } },
  });
}

async function upsertSchedule(businessUserId, { enabled, groupId, frequency, timeOfDay, dayOfWeek, dayOfMonth, externalPayoutMethod, reference }) {
  await assertEligibleBusiness(businessUserId);

  if (groupId) {
    const group = await prisma.beneficiaryGroup.findUnique({ where: { id: groupId } });
    if (!group || group.businessUserId !== businessUserId) {
      throw new PerDiemError('Liste de bénéficiaires introuvable', 404);
    }
  }

  const data = {
    enabled,
    groupId: groupId ?? null,
    frequency,
    timeOfDay,
    dayOfWeek: frequency === 'WEEKLY' ? dayOfWeek : null,
    dayOfMonth: frequency === 'MONTHLY' ? dayOfMonth : null,
    externalPayoutMethod: externalPayoutMethod ?? null,
    reference: reference ?? null,
  };

  return prisma.perDiemSchedule.upsert({
    where: { businessUserId },
    update: data,
    create: { businessUserId, ...data },
    include: { group: { select: { id: true, name: true } } },
  });
}

// Pure (pas d'accès base) pour rester facilement testable : étant donné
// un schedule et l'instant présent, doit-il se déclencher maintenant ?
// Compare toujours à l'heure du créneau DU JOUR (todayTrigger), jamais à
// lastRunAt seul - sinon un lot lancé à 7h01 un lundi serait injustement
// repoussé au mardi si on comparait juste "lastRunAt < maintenant".
function isDue(schedule, now = new Date()) {
  if (!schedule.enabled || !schedule.groupId) return false;

  const [hh, mm] = (schedule.timeOfDay || '07:00').split(':').map(Number);
  const todayTrigger = new Date(now);
  todayTrigger.setHours(hh, mm, 0, 0);

  if (schedule.frequency === 'WEEKLY' && now.getDay() !== schedule.dayOfWeek) return false;
  if (schedule.frequency === 'MONTHLY' && now.getDate() !== schedule.dayOfMonth) return false;

  if (now < todayTrigger) return false;
  if (schedule.lastRunAt && new Date(schedule.lastRunAt) >= todayTrigger) return false;

  return true;
}

// Coeur d'exécution, partagé entre le déclenchement manuel ("Tester
// maintenant") et le script cron (run-per-diem.js) - jamais de double
// logique entre les deux. Les membres sans montant par défaut sont
// ignorés plutôt que de faire échouer tout le lot : personne n'est présent
// à 7h du matin pour répondre "combien pour celui-là ?".
async function executeSchedule(schedule) {
  const group = await prisma.beneficiaryGroup.findUnique({
    where: { id: schedule.groupId },
    include: { members: true },
  });

  if (!group) {
    return finalizeRun(schedule, { lastRunStatus: 'Liste de bénéficiaires introuvable, non exécuté', lastRunBulkPayoutId: null });
  }

  const items = group.members
    .filter((m) => m.defaultAmount != null)
    .map((m) => ({ phone: m.phone, amount: Number(m.defaultAmount), reference: m.defaultReference || schedule.reference || undefined }));

  if (items.length === 0) {
    return finalizeRun(schedule, { lastRunStatus: 'Aucun membre avec un montant défini, non exécuté', lastRunBulkPayoutId: null });
  }

  const result = await bulkPayoutService.createBulkPayout(schedule.businessUserId, {
    items,
    reference: schedule.reference || 'Paiement automatique du personnel',
    idempotencyKey: crypto.randomUUID(),
    externalPayoutMethod: schedule.externalPayoutMethod || undefined,
  });

  return finalizeRun(schedule, {
    lastRunStatus: `${result.successCount} réussi(s), ${result.failedCount} échoué(s)`,
    lastRunBulkPayoutId: result.id,
  });
}

async function finalizeRun(schedule, { lastRunStatus, lastRunBulkPayoutId }) {
  return prisma.perDiemSchedule.update({
    where: { id: schedule.id },
    data: { lastRunAt: new Date(), lastRunStatus, lastRunBulkPayoutId },
  });
}

// Déclenchement manuel par l'entreprise elle-même, pour tester sans
// attendre le prochain créneau automatique - fonctionne même si
// l'automatisation est actuellement désactivée (un test n'active rien).
async function runNow(businessUserId) {
  await assertEligibleBusiness(businessUserId);
  const schedule = await prisma.perDiemSchedule.findUnique({ where: { businessUserId } });
  if (!schedule || !schedule.groupId) {
    throw new PerDiemError('Configurez une liste de bénéficiaires avant de tester', 400);
  }
  return executeSchedule(schedule);
}

// Appelé par scripts/run-per-diem.js (programmé via un vrai cron externe,
// même principe que retry-webhooks.js) - jamais depuis une route HTTP
// classique, aucun humain n'est présent pour taper un code de
// confirmation à l'heure programmée. L'autorisation est celle donnée à
// l'avance par l'entreprise en activant l'automatisation elle-même.
async function runDueSchedules(now = new Date()) {
  const schedules = await prisma.perDiemSchedule.findMany({ where: { enabled: true } });
  const due = schedules.filter((s) => isDue(s, now));

  const results = [];
  for (const schedule of due) {
    try {
      await executeSchedule(schedule);
      results.push({ businessUserId: schedule.businessUserId, ok: true });
    } catch (err) {
      await finalizeRun(schedule, { lastRunStatus: `Erreur : ${err.message || 'inconnue'}`, lastRunBulkPayoutId: null });
      results.push({ businessUserId: schedule.businessUserId, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  PerDiemError,
  getSchedule,
  upsertSchedule,
  isDue,
  runNow,
  runDueSchedules,
};

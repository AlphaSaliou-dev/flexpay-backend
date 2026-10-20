const prisma = require('../../config/db');
const { sendOtpBySms } = require('../../utils/otp');
const { logger } = require('../../utils/logger');

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

class NotificationError extends Error {
  constructor(message, statusCode = 404) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Un token push Expo a toujours ce préfixe - permet de rejeter tout de
// suite une valeur invalide sans faire d'appel réseau inutile.
function isValidExpoPushToken(token) {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

async function registerPushToken(userId, token) {
  if (!isValidExpoPushToken(token)) {
    throw new Error('Token de notification invalide');
  }
  await prisma.user.update({ where: { id: userId }, data: { pushToken: token } });
}

// Seule cette catégorie correspond à "Demandes de paiement" côté
// préférences - tout le reste (dépôt, paiement, transfert, KYC/KYB...)
// tombe sous "Opérations sur mon compte". La sécurité n'est jamais
// désactivable : couper l'alerte "quelqu'un vient de se connecter à votre
// compte" viderait cette notification de son utilité.
const SECURITY_TYPES = new Set(['NEW_LOGIN', 'PASSWORD_CHANGED', 'ACCOUNT_LOCKED', 'TRANSACTION_PIN_CHANGED', 'TRANSACTION_PIN_LOCKED']);

function categoryFor(type) {
  if (type === 'PAYMENT_REQUEST_PENDING') return 'paymentRequests';
  if (SECURITY_TYPES.has(type)) return 'security';
  return 'transactions';
}

// Envoie une notification push si l'utilisateur en a un configuré ; sinon
// (ou si l'envoi échoue) retombe automatiquement sur un SMS - jamais un
// utilisateur ne doit rater une notification importante juste parce que
// son token push a expiré ou n'a jamais été enregistré. La ligne
// d'historique, elle, est TOUJOURS créée : couper le push/SMS pour une
// catégorie ne doit jamais faire disparaître l'évènement du journal
// consultable dans l'app.
async function notifyUser(userId, { type, title, body, data }, smsFallbackText) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  await prisma.notification.create({ data: { userId, type, title, body, data } });

  const category = categoryFor(type);
  const enabled =
    category === 'security'
      ? true
      : category === 'paymentRequests'
        ? user.notifyOnPaymentRequests
        : user.notifyOnTransactions;
  if (!enabled) return;

  if (user.pushToken && isValidExpoPushToken(user.pushToken)) {
    try {
      const res = await fetch(EXPO_PUSH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: user.pushToken, title, body, data, sound: 'default' }),
      });
      const result = await res.json().catch(() => null);

      // Expo répond 200 même pour un token révoqué - le vrai statut est
      // dans le corps de la réponse ("ok" ou "error"). Un "DeviceNotRegistered"
      // signifie que l'utilisateur a désinstallé l'app ou révoqué les
      // permissions - dans ce cas, on efface le token pour ne plus jamais
      // réessayer inutilement, et on retombe sur SMS pour CETTE notification.
      const ticket = result?.data;
      if (ticket?.status === 'ok') return;

      if (ticket?.details?.error === 'DeviceNotRegistered') {
        await prisma.user.update({ where: { id: userId }, data: { pushToken: null } });
      }
    } catch (err) {
      logger.warn({ err: err.message, userId }, '[notifications] échec envoi push, repli SMS');
    }
  }

  if (smsFallbackText) {
    await sendOtpBySms(user.phone, smsFallbackText);
  }
}

// --- Journal consultable (écran Notifications) ------------------------------

async function listNotifications(userId, { limit = 50 } = {}) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });
}

async function markAsRead(userId, notificationId) {
  const notif = await prisma.notification.findUnique({ where: { id: notificationId } });

  // Même erreur qu'un id inexistant si la notification appartient à un
  // autre utilisateur - ne jamais révéler qu'une notification d'un tiers
  // existe (même logique que partout ailleurs dans le back-office).
  if (!notif || notif.userId !== userId) {
    throw new NotificationError('Notification introuvable', 404);
  }

  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}

async function markAllAsRead(userId) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { markedAllRead: true };
}

// --- Préférences ------------------------------------------------------------

async function getPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notifyOnTransactions: true, notifyOnPaymentRequests: true },
  });
  if (!user) throw new NotificationError('Utilisateur introuvable', 404);
  return user;
}

async function updatePreferences(userId, { notifyOnTransactions, notifyOnPaymentRequests }) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(notifyOnTransactions !== undefined && { notifyOnTransactions }),
      ...(notifyOnPaymentRequests !== undefined && { notifyOnPaymentRequests }),
    },
    select: { notifyOnTransactions: true, notifyOnPaymentRequests: true },
  });
}

module.exports = {
  NotificationError,
  registerPushToken,
  notifyUser,
  isValidExpoPushToken,
  listNotifications,
  markAsRead,
  markAllAsRead,
  getPreferences,
  updatePreferences,
};

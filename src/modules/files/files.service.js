const crypto = require('crypto');
const prisma = require('../../config/db');
const virusScan = require('./virusScan.service');
const { encryptBuffer, decryptBuffer } = require('../../utils/encryption');

const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';
const storage = require(`./storage/${STORAGE_PROVIDER}Storage`);

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_MB || 5) * 1024 * 1024;

class FileError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertValidFile(file) {
  if (!file) throw new FileError('Aucun fichier fourni', 400);
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new FileError('Type de fichier non autorisé (JPEG, PNG ou PDF uniquement)', 400);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new FileError(`Fichier trop volumineux (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} Mo)`, 400);
  }
}

// Le nom de fichier d'origine n'est JAMAIS utilisé comme clé de stockage -
// il peut contenir des caractères dangereux ou révéler des informations.
// On génère une clé aléatoire, préfixée par l'utilisateur pour l'organisation.
async function uploadFile(ownerUserId, purpose, file) {
  assertValidFile(file);

  // Scan antivirus AVANT toute écriture sur le stockage définitif -
  // jamais un fichier potentiellement infecté ne doit toucher le disque
  // persistant, même temporairement. Les erreurs du scanner
  // (VirusDetectedError, ScanUnavailableError) remontent telles quelles,
  // avec leur propre statusCode, gérées par le contrôleur comme les
  // FileError habituelles.
  await virusScan.assertFileIsSafe(file.buffer);

  const extension = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1];
  const storageKey = `${ownerUserId}/${purpose.toLowerCase()}/${crypto.randomUUID()}.${extension}`;

  // Chiffré avant d'atteindre le disque (ou tout backend de stockage,
  // local ou S3 plus tard) - une pièce d'identité ou un selfie ne doit
  // jamais être lisible par quiconque a juste un accès au stockage, pas
  // seulement par quelqu'un qui aurait accès à la base de données.
  await storage.save(encryptBuffer(file.buffer), storageKey);

  const asset = await prisma.fileAsset.create({
    data: {
      ownerUserId,
      purpose,
      storageKey,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      encryptedAtRest: true,
    },
  });

  // Référence renvoyée à l'appelant (ex: pour idDocumentUrl du module KYC) :
  // une URL vers notre propre route protégée, jamais un accès direct au
  // stockage - c'est ce qui permet le contrôle d'accès à la lecture.
  return { fileId: asset.id, url: `/api/v1/files/${asset.id}` };
}

// Déchiffre seulement si le fichier a réellement été chiffré à l'écriture
// (encryptedAtRest) - un fichier antérieur à cette fonctionnalité, pas
// encore migré par scripts/encrypt-existing-files.js, reste lisible tel
// quel plutôt que de faire échouer la lecture avec une erreur de
// déchiffrement trompeuse.
async function readAndDecrypt(asset) {
  const raw = await storage.read(asset.storageKey);
  return asset.encryptedAtRest ? decryptBuffer(raw) : raw;
}

// Contrôle d'accès : le fichier n'est lisible QUE par son propriétaire, ou
// par un admin habilité (COMPLIANCE/SUPERADMIN, pour la revue KYC/KYB).
// Sans cette vérification, n'importe quel utilisateur connecté pourrait
// lire la pièce d'identité de n'importe qui en devinant un id.
async function getFileForOwner(fileId, requestingUserId) {
  const asset = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset) throw new FileError('Fichier introuvable', 404);
  if (asset.ownerUserId !== requestingUserId) {
    throw new FileError('Accès refusé', 403);
  }
  const buffer = await readAndDecrypt(asset);
  return { buffer, mimeType: asset.mimeType };
}

async function getFileForAdmin(fileId) {
  const asset = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset) throw new FileError('Fichier introuvable', 404);
  const buffer = await readAndDecrypt(asset);
  return { buffer, mimeType: asset.mimeType };
}

// Usage interne uniquement (jamais exposé par une route HTTP directement) :
// pas de contrôle d'accès par propriétaire, réservé à un traitement
// serveur-à-serveur déclenché dans le même flux que l'upload (ex: la
// comparaison faciale juste après la soumission KYC). Ne JAMAIS appeler
// ceci depuis un contrôleur exposé sans revérifier les droits en amont.
async function getFileBuffer(fileId) {
  const asset = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset) throw new FileError('Fichier introuvable', 404);
  const buffer = await readAndDecrypt(asset);
  return { buffer, mimeType: asset.mimeType };
}

module.exports = { FileError, uploadFile, getFileForOwner, getFileForAdmin, getFileBuffer };

const multer = require('multer');

const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_MB || 5) * 1024 * 1024;

// Stockage en mémoire (pas sur disque directement) : le buffer passe par
// files.service.js qui valide le type et la taille avant d'appeler le
// backend de stockage - jamais un fichier brut écrit sans validation.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

module.exports = { upload };

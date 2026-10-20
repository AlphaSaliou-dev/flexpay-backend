const filesService = require('../files/files.service');

const FACE_MATCH_PROVIDER = process.env.FACE_MATCH_PROVIDER || 'mock';
const provider = require(`./faceMatchProviders/${FACE_MATCH_PROVIDER}Provider`);

// L'URL stockée en base pointe vers la route "fichier utilisateur"
// (/api/v1/files/:id) - on en extrait l'id pour lire le fichier
// directement en interne, sans repasser par HTTP.
function extractFileId(fileUrl) {
  return fileUrl.split('/').pop();
}

async function compareIdWithSelfie(idDocumentUrl, selfieUrl) {
  const idFile = await filesService.getFileBuffer(extractFileId(idDocumentUrl));
  const selfieFile = await filesService.getFileBuffer(extractFileId(selfieUrl));

  const result = await provider.compareFaces(idFile.buffer, selfieFile.buffer);
  return result; // { status: 'MATCH' | 'NO_MATCH' | 'INCONCLUSIVE', score }
}

module.exports = { compareIdWithSelfie };

const filesService = require('./files.service');
const { logError } = require('../../utils/logger');
const { PURPOSES } = require('./files.validation');
const { VirusDetectedError, ScanUnavailableError } = require('./virusScan.service');

async function uploadFile(req, res) {
  try {
    const { purpose } = req.query;

    if (!PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `Paramètre purpose invalide (attendu: ${PURPOSES.join(', ')})` });
    }

    const result = await filesService.uploadFile(req.user.id, purpose, req.file);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof filesService.FileError || err instanceof VirusDetectedError || err instanceof ScanUnavailableError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('files', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

async function getFile(req, res) {
  try {
    const { buffer, mimeType } = await filesService.getFileForOwner(req.params.id, req.user.id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store'); // jamais mis en cache par un proxy intermédiaire
    res.send(buffer);
  } catch (err) {
    if (err instanceof filesService.FileError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('files', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

async function getFileAsAdmin(req, res) {
  try {
    const { buffer, mimeType } = await filesService.getFileForAdmin(req.params.id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  } catch (err) {
    if (err instanceof filesService.FileError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('files', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { uploadFile, getFile, getFileAsAdmin };

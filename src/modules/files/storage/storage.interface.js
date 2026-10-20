// Interface (JSDoc) que TOUT backend de stockage doit implémenter. Le
// reste de l'app n'appelle jamais un backend directement - toujours à
// travers cette forme, sélectionnée via STORAGE_PROVIDER dans .env.
//
// Méthodes attendues :
//   save(buffer, key, mimeType) -> Promise<void>
//   read(key)                   -> Promise<Buffer>
//   delete(key)                 -> Promise<void>
//
// L'implémentation locale (localStorage.js) sert au développement.
// Avant toute mise en production, la remplacer par un backend
// S3-compatible avec chiffrement au repos (ex: AWS S3 + SSE, DigitalOcean
// Spaces) - jamais de stockage local sur le serveur applicatif en prod.

module.exports = {}; // documentation uniquement

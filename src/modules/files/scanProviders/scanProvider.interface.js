// Interface (JSDoc) que TOUT fournisseur de scan antivirus doit
// implémenter. Sélectionné via VIRUS_SCAN_PROVIDER dans .env.
//
// Méthode attendue :
//   scanBuffer(buffer) -> { clean: boolean, signature: string | null }
//
// Implémentation par défaut (clamavProvider.js) : ClamAV réel via le
// binaire `clamscan`, pas une simulation. En développement dans cet
// environnement, la base de signatures officielle (database.clamav.net)
// est inaccessible - une signature de test (EICAR, le fichier de test
// standard de l'industrie antivirus) est utilisée à la place pour
// prouver que l'intégration fonctionne réellement de bout en bout.
// Avant toute mise en production, exécuter `freshclam` sur le serveur
// (avec accès internet normal) pour charger la vraie base de
// signatures - aucun changement de code requis, seulement l'exécution de
// cette commande sur l'infrastructure réelle.

module.exports = {}; // documentation uniquement

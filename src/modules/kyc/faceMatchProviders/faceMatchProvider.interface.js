// Interface (JSDoc) que TOUT fournisseur de correspondance faciale doit
// implémenter. Sélectionné via FACE_MATCH_PROVIDER dans .env.
//
// Méthode attendue :
//   compareFaces(idDocumentBuffer, selfieBuffer) -> { status, score }
//   où status ∈ 'MATCH' | 'NO_MATCH' | 'INCONCLUSIVE'
//   et score est un nombre entre 0 et 1 (ou null si inconclusif).
//
// Fournisseurs réels à considérer avant la production : Smile Identity
// (le plus utilisé pour le KYC biométrique en Afrique, couvre plusieurs
// pays d'Afrique de l'Ouest), AWS Rekognition, ou Onfido/Jumio pour une
// couverture plus internationale.
//
// L'implémentation par défaut (mockProvider.js) ne fait AUCUNE vraie
// comparaison - elle renvoie toujours INCONCLUSIVE. C'est volontaire :
// mieux vaut afficher clairement "non vérifié automatiquement, à
// contrôler humainement" que de simuler un résultat positif qui n'a
// jamais réellement comparé deux visages.

module.exports = {}; // documentation uniquement

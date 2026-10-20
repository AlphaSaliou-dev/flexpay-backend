// Interface (au sens JSDoc, pas TypeScript) que TOUT fournisseur de carte
// virtuelle doit implémenter. Le reste de l'app n'appelle jamais un
// fournisseur directement - toujours à travers cette forme, sélectionnée
// via CARD_PROVIDER dans .env. Changer de partenaire d'émission demain ne
// doit toucher qu'un fichier : le nouveau provider.
//
// Méthodes attendues :
//   createCard(user)                    -> { providerCardId, maskedNumber, currency }
//   topUp(providerCardId, amount)       -> { success, providerReference }
//   freeze(providerCardId)              -> { success }
//   unfreeze(providerCardId)            -> { success }
//   close(providerCardId)               -> { success }
//   getBalance(providerCardId)          -> { balance, currency }
//
// Chaque implémentation concrète (ex: providers/someIssuer.js) doit
// exporter ces mêmes méthodes avec cette même signature.

module.exports = {}; // documentation uniquement - pas de code exécutable ici

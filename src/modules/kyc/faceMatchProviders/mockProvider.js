// Aucun vrai fournisseur connecté = toujours INCONCLUSIVE. Ne jamais
// remplacer ce comportement par un faux "MATCH" automatique tant qu'un
// vrai service de comparaison biométrique n'est pas branché - un dossier
// KYC avec un score inventé serait pire qu'aucun contrôle du tout,
// puisqu'il donnerait un faux sentiment de sécurité à la revue admin.
async function compareFaces(idDocumentBuffer, selfieBuffer) {
  console.log('[MOCK FACE MATCH] Aucun fournisseur réel connecté - résultat toujours INCONCLUSIVE');
  return { status: 'INCONCLUSIVE', score: null };
}

module.exports = { compareFaces };

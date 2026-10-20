// Taux approximatif GNF/USD - UNIQUEMENT pour afficher un équivalent GNF
// indicatif de la carte virtuelle (elle-même toujours en USD, voir
// VirtualCard.currency). À remplacer par un flux de change en temps réel
// une fois un vrai fournisseur de carte intégré - en attendant, mieux vaut
// une approximation clairement documentée qu'un 1:1 arbitraire (bug
// précédent de virtualCard.service.topUp).
const GNF_PER_USD = 8600;

function gnfToUsd(amountGnf) {
  return Math.round((Number(amountGnf) / GNF_PER_USD) * 100) / 100;
}

function usdToGnf(amountUsd) {
  return Math.round(Number(amountUsd) * GNF_PER_USD);
}

module.exports = { GNF_PER_USD, gnfToUsd, usdToGnf };

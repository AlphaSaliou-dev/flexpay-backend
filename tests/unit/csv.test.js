const { toCsv } = require('../../src/utils/csv');

describe('toCsv', () => {
  test('génère un en-tête et des lignes correctement séparés par des virgules', () => {
    const csv = toCsv(
      [{ name: 'Aminata', amount: 5000 }],
      [{ key: 'name', label: 'Nom' }, { key: 'amount', label: 'Montant' }]
    );
    expect(csv).toBe('Nom,Montant\r\nAminata,5000');
  });

  test('échappe les champs contenant une virgule, un guillemet ou un retour à la ligne', () => {
    const csv = toCsv(
      [{ ref: 'Frais, scolarité "Avril"\nCompte A' }],
      [{ key: 'ref', label: 'Référence' }]
    );
    expect(csv).toBe('Référence\r\n"Frais, scolarité ""Avril""\nCompte A"');
  });

  test('gère les valeurs null/undefined comme des chaînes vides, sans planter', () => {
    const csv = toCsv([{ a: null, b: undefined }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
    expect(csv).toBe('A,B\r\n,');
  });

  test('retourne uniquement l\'en-tête si aucune ligne', () => {
    const csv = toCsv([], [{ key: 'a', label: 'A' }]);
    expect(csv).toBe('A');
  });
});

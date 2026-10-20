const mockPrisma = { sanctionedEntity: { findMany: jest.fn() } };
jest.mock('../../src/config/db', () => mockPrisma);

const { screenName, screenNames, similarityScore, normalize } = require('../../src/modules/compliance/sanctionsScreening.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('normalize', () => {
  test('retire les accents, met en minuscule, et normalise les espaces', () => {
    expect(normalize('  Jean-François ÉLOI  ')).toBe('jeanfrancois eloi');
  });
});

describe('similarityScore', () => {
  test('retourne 0 pour deux noms strictement identiques (une fois normalisés)', () => {
    expect(similarityScore('Amadou Diallo', 'amadou diallo')).toBe(0);
  });

  test('retourne un score élevé pour deux noms complètement différents', () => {
    expect(similarityScore('Amadou Diallo', 'Xu Wei Zhang')).toBeGreaterThan(0.5);
  });

  test('retourne un score faible pour une simple faute de frappe', () => {
    expect(similarityScore('Amadou Diallo', 'Amadou Dialo')).toBeLessThan(0.15);
  });
});

describe('screenName', () => {
  test('ne renvoie aucun hit sur une liste vide', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([]);
    const result = await screenName('Amadou Diallo');
    expect(result).toEqual({ hit: false, matches: [] });
  });

  test('ne plante pas et ne matche rien sur un nom vide', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([{ id: 'e1', fullName: 'Test', aliases: [], type: 'SANCTIONS', source: 'x' }]);
    const result = await screenName('');
    expect(result).toEqual({ hit: false, matches: [] });
  });

  test('détecte une correspondance exacte avec le nom complet d\'une entité', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([
      { id: 'e1', fullName: 'Jean Test Sanctionné', aliases: [], type: 'SANCTIONS', source: 'Test fictif' },
    ]);
    const result = await screenName('Jean Test Sanctionné');
    expect(result.hit).toBe(true);
    expect(result.matches[0].entityId).toBe('e1');
    expect(result.matches[0].score).toBe(0);
  });

  test('détecte une correspondance via un alias, pas seulement le nom principal', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([
      { id: 'e1', fullName: 'Jean Test Sanctionné', aliases: ['J. Test Sanctionné'], type: 'SANCTIONS', source: 'Test fictif' },
    ]);
    const result = await screenName('J. Test Sanctionné');
    expect(result.hit).toBe(true);
    expect(result.matches[0].matchedAlias).toBe('J. Test Sanctionné');
  });

  test('ne signale rien pour un nom clairement différent de tous les noms de la liste', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([
      { id: 'e1', fullName: 'Jean Test Sanctionné', aliases: [], type: 'SANCTIONS', source: 'Test fictif' },
    ]);
    const result = await screenName('Mariama Camara');
    expect(result.hit).toBe(false);
  });

  test('trie les correspondances multiples de la plus proche à la moins proche', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([
      { id: 'e1', fullName: 'Amadou Diallo', aliases: [], type: 'SANCTIONS', source: 'x' },
      { id: 'e2', fullName: 'Amadou Dialo', aliases: [], type: 'SANCTIONS', source: 'x' }, // plus proche (1 lettre en moins)
    ]);
    const result = await screenName('Amadou Diallo');
    expect(result.matches[0].entityId).toBe('e1'); // correspondance exacte en premier
  });
});

describe('screenNames', () => {
  test('fusionne les correspondances de plusieurs noms (ex: entreprise + représentant légal)', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([
      { id: 'e1', fullName: 'Entreprise Fictive SARL', aliases: [], type: 'SANCTIONS', source: 'x' },
    ]);
    const result = await screenNames(['Entreprise Fictive SARL', 'Un Représentant Quelconque']);
    expect(result.hit).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  test('ignore les entrées vides/null dans la liste de noms', async () => {
    mockPrisma.sanctionedEntity.findMany.mockResolvedValue([]);
    await expect(screenNames([null, undefined, ''])).resolves.toEqual({ hit: false, matches: [] });
  });
});

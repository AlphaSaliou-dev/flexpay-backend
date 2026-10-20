const { parsePagination, buildPaginatedResult, MAX_PAGE_SIZE } = require('../../src/utils/pagination');

describe('parsePagination', () => {
  test('utilise page=1 et la taille par défaut si rien n\'est fourni', () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 20, skip: 0, take: 20 });
  });

  test('calcule correctement skip pour une page donnée', () => {
    expect(parsePagination({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10, skip: 20, take: 10 });
  });

  test('rejette une page négative ou à zéro en la ramenant à 1', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: '-5' }).page).toBe(1);
  });

  test('plafonne pageSize pour empêcher une requête abusive (ex: pageSize=100000)', () => {
    expect(parsePagination({ pageSize: '999999' }).pageSize).toBe(MAX_PAGE_SIZE);
  });

  test('ignore une valeur non numérique et retombe sur les défauts', () => {
    expect(parsePagination({ page: 'abc', pageSize: 'xyz' })).toEqual({ page: 1, pageSize: 20, skip: 0, take: 20 });
  });
});

describe('buildPaginatedResult', () => {
  test('calcule totalPages correctement, y compris avec un reste', () => {
    const result = buildPaginatedResult([1, 2], 45, 1, 20);
    expect(result.pagination.totalPages).toBe(3); // 45 / 20 = 2.25 -> 3
  });

  test('totalPages vaut toujours au moins 1, même sans aucun résultat', () => {
    const result = buildPaginatedResult([], 0, 1, 20);
    expect(result.pagination.totalPages).toBe(1);
  });
});

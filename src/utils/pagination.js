const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Centralisé pour que toutes les listes paginées de l'admin se comportent
// pareil (mêmes noms de paramètres, mêmes limites) - jamais une page qui
// accepte pageSize=10000 par erreur et plombe la base.
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function buildPaginatedResult(items, total, page, pageSize) {
  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

module.exports = { parsePagination, buildPaginatedResult, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };

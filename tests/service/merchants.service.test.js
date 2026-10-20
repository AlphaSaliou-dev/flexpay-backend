const mockPrisma = {
  businessProfile: { findMany: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const merchantsService = require('../../src/modules/merchants/merchants.service');

beforeEach(() => {
  jest.clearAllMocks();
});

function makeProfile(overrides = {}) {
  return {
    userId: 'business-1',
    businessName: 'École Les Palmiers',
    receiptLogoUrl: null,
    category: null,
    location: null,
    ...overrides,
  };
}

describe('searchMerchants', () => {
  test('ne filtre que les comptes Business déjà validés KYB (reviewStatus)', async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);

    await merchantsService.searchMerchants('École');

    const call = mockPrisma.businessProfile.findMany.mock.calls[0][0];
    expect(call.where.reviewStatus).toBe('APPROVED');
  });

  test("n'expose jamais le RCCM, le NIF ou une autre donnée de dossier - seulement l'annuaire public", async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);

    await merchantsService.searchMerchants('École');

    const call = mockPrisma.businessProfile.findMany.mock.calls[0][0];
    expect(call.select).toEqual({
      userId: true,
      businessName: true,
      receiptLogoUrl: true,
      category: true,
      location: true,
    });
  });

  test('renvoie le logo, la catégorie et la localisation en plus du nom et de l\'id', async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([
      makeProfile({ receiptLogoUrl: '/api/v1/files/logo-1', category: 'Éducation', location: 'Kaloum, Conakry' }),
    ]);

    const results = await merchantsService.searchMerchants('École');

    expect(results).toEqual([
      {
        businessUserId: 'business-1',
        businessName: 'École Les Palmiers',
        logoUrl: '/api/v1/files/logo-1',
        category: 'Éducation',
        location: 'Kaloum, Conakry',
      },
    ]);
  });
});

describe('listMerchants', () => {
  test('ne requiert aucun terme de recherche', async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);

    await merchantsService.listMerchants();

    const call = mockPrisma.businessProfile.findMany.mock.calls[0][0];
    expect(call.where.reviewStatus).toBe('APPROVED');
    expect(call.where.businessName).toBeUndefined();
  });

  test('filtre par catégorie quand elle est fournie', async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);

    await merchantsService.listMerchants({ category: 'Santé' });

    const call = mockPrisma.businessProfile.findMany.mock.calls[0][0];
    expect(call.where.category).toBe('Santé');
  });

  test("n'applique aucun filtre de catégorie quand elle est absente", async () => {
    mockPrisma.businessProfile.findMany.mockResolvedValue([]);

    await merchantsService.listMerchants({});

    const call = mockPrisma.businessProfile.findMany.mock.calls[0][0];
    expect(call.where.category).toBeUndefined();
  });
});

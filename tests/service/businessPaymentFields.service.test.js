const mockPrisma = {
  businessProfile: { findUnique: jest.fn(), update: jest.fn() },
  businessPaymentField: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

const fieldsService = require('../../src/modules/payments/businessPaymentFields.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('slugifyLabel', () => {
  test('convertit un libellé humain en clé technique stable', () => {
    expect(fieldsService.slugifyLabel("Nom de l'élève")).toBe('nom_de_l_eleve');
  });

  test('retire les accents et normalise la casse', () => {
    expect(fieldsService.slugifyLabel('Numéro de Dossier')).toBe('numero_de_dossier');
  });

  test('gère les espaces multiples et la ponctuation', () => {
    expect(fieldsService.slugifyLabel('  Classe  /  Niveau !  ')).toBe('classe_niveau');
  });
});

describe('createField', () => {
  test('rejette si le compte Business est introuvable', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue(null);
    await expect(fieldsService.createField('user-1', { label: 'Test' })).rejects.toThrow('introuvable');
  });

  test('rejette au-delà du nombre maximum de champs autorisés', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', user: { accountType: 'BUSINESS' } });
    mockPrisma.businessPaymentField.count.mockResolvedValue(fieldsService.MAX_FIELDS_PER_BUSINESS);

    await expect(fieldsService.createField('user-1', { label: 'Encore un champ' })).rejects.toThrow(/Maximum/);
    expect(mockPrisma.businessPaymentField.create).not.toHaveBeenCalled();
  });

  test('rejette au-delà du champ unique autorisé pour un compte Marchand', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', user: { accountType: 'MERCHANT' } });
    mockPrisma.businessPaymentField.count.mockResolvedValue(fieldsService.MAX_FIELDS_PER_MERCHANT);

    await expect(fieldsService.createField('user-1', { label: 'Encore un champ' })).rejects.toThrow(/Maximum/);
    expect(mockPrisma.businessPaymentField.create).not.toHaveBeenCalled();
  });

  test('rejette un doublon (même clé technique déjà utilisée par ce compte)', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', user: { accountType: 'BUSINESS' } });
    mockPrisma.businessPaymentField.count.mockResolvedValue(2);
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue({ id: 'existing-field' });

    await expect(fieldsService.createField('user-1', { label: 'Nom de l\'élève' })).rejects.toThrow(/existe déjà/);
  });

  test('crée bien le champ avec sa clé technique dérivée', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', user: { accountType: 'BUSINESS' } });
    mockPrisma.businessPaymentField.count.mockResolvedValue(0);
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue(null);
    mockPrisma.businessPaymentField.create.mockResolvedValue({ id: 'new-field' });

    await fieldsService.createField('user-1', { label: 'Classe' });

    const call = mockPrisma.businessPaymentField.create.mock.calls[0][0].data;
    expect(call.fieldKey).toBe('classe');
    expect(call.businessProfileId).toBe('profile-1');
  });
});

describe('updateField / deleteField - propriété vérifiée', () => {
  test('updateField rejette si le champ appartient à un autre compte', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1' });
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue({ id: 'f1', businessProfileId: 'autre-profile' });

    await expect(fieldsService.updateField('user-1', 'f1', { label: 'x' })).rejects.toThrow('introuvable');
    expect(mockPrisma.businessPaymentField.update).not.toHaveBeenCalled();
  });

  test('deleteField rejette si le champ appartient à un autre compte', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1' });
    mockPrisma.businessPaymentField.findUnique.mockResolvedValue({ id: 'f1', businessProfileId: 'autre-profile' });

    await expect(fieldsService.deleteField('user-1', 'f1')).rejects.toThrow('introuvable');
    expect(mockPrisma.businessPaymentField.delete).not.toHaveBeenCalled();
  });
});

describe('listFieldsForPayer', () => {
  test('retourne un tableau vide pour un compte Business non validé (jamais d\'exposition avant approbation)', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', reviewStatus: 'PENDING' });
    const result = await fieldsService.listFieldsForPayer('user-1');
    expect(result).toEqual([]);
    expect(mockPrisma.businessPaymentField.findMany).not.toHaveBeenCalled();
  });

  test('retourne les champs pour un compte Business validé', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', reviewStatus: 'APPROVED' });
    mockPrisma.businessPaymentField.findMany.mockResolvedValue([{ id: 'f1', label: 'Classe', fieldKey: 'classe', required: true }]);

    const result = await fieldsService.listFieldsForPayer('user-1');
    expect(result).toHaveLength(1);
  });
});

describe('assertCustomFieldsComplete', () => {
  test('rejette si un champ requis est manquant, en nommant précisément lequel', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', reviewStatus: 'APPROVED' });
    mockPrisma.businessPaymentField.findMany.mockResolvedValue([
      { id: 'f1', label: "Nom de l'élève", fieldKey: 'nom_de_leleve', required: true },
      { id: 'f2', label: 'Classe', fieldKey: 'classe', required: false },
    ]);

    await expect(fieldsService.assertCustomFieldsComplete('user-1', {})).rejects.toThrow(/Nom de l'élève/);
  });

  test('accepte si tous les champs requis sont fournis (les optionnels peuvent manquer)', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', reviewStatus: 'APPROVED' });
    mockPrisma.businessPaymentField.findMany.mockResolvedValue([
      { id: 'f1', label: "Nom de l'élève", fieldKey: 'nom_de_leleve', required: true },
      { id: 'f2', label: 'Classe', fieldKey: 'classe', required: false },
    ]);

    await expect(
      fieldsService.assertCustomFieldsComplete('user-1', { nom_de_leleve: 'Mariama Camara' })
    ).resolves.toBeDefined();
  });

  test('un champ requis rempli uniquement d\'espaces est considéré comme manquant', async () => {
    mockPrisma.businessProfile.findUnique.mockResolvedValue({ id: 'profile-1', reviewStatus: 'APPROVED' });
    mockPrisma.businessPaymentField.findMany.mockResolvedValue([
      { id: 'f1', label: 'Classe', fieldKey: 'classe', required: true },
    ]);

    await expect(fieldsService.assertCustomFieldsComplete('user-1', { classe: '   ' })).rejects.toThrow(/Classe/);
  });
});

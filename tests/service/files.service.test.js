process.env.STORAGE_PROVIDER = 'local';
process.env.ENCRYPTION_KEY = '7b1c9e2f4a6d8035c1e7f90a2b4d6e8035c1e7f90a2b4d6e8035c1e7f90a2b4d';

const mockPrisma = { fileAsset: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() } };
jest.mock('../../src/config/db', () => mockPrisma);

const mockStorageSave = jest.fn();
const mockStorageRead = jest.fn();
jest.mock('../../src/modules/files/storage/localStorage', () => ({
  save: (...args) => mockStorageSave(...args),
  read: (...args) => mockStorageRead(...args),
  delete: jest.fn(),
}));

const mockAssertFileIsSafe = jest.fn();
jest.mock('../../src/modules/files/virusScan.service', () => ({
  assertFileIsSafe: (...args) => mockAssertFileIsSafe(...args),
  VirusDetectedError: class VirusDetectedError extends Error {
    constructor(sig) {
      super(`Fichier rejeté : signature virale détectée (${sig})`);
      this.statusCode = 422;
    }
  },
  ScanUnavailableError: class ScanUnavailableError extends Error {
    constructor() {
      super('Scan antivirus indisponible');
      this.statusCode = 503;
    }
  },
}));

const filesService = require('../../src/modules/files/files.service');

function makeFile(overrides = {}) {
  return {
    buffer: Buffer.from('contenu factice'),
    mimetype: 'image/jpeg',
    size: 1024,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertFileIsSafe.mockResolvedValue(true);
});

describe('uploadFile - intégration du scan antivirus', () => {
  test('scanne le fichier AVANT toute écriture sur le stockage', async () => {
    mockPrisma.fileAsset.create.mockResolvedValue({ id: 'file-1' });

    await filesService.uploadFile('user-1', 'KYC_ID_DOCUMENT', makeFile());

    // L'ordre d'appel compte : le scan doit précéder l'écriture, jamais
    // l'inverse - un fichier infecté ne doit jamais toucher le stockage
    // persistant, même un instant.
    const scanCallOrder = mockAssertFileIsSafe.mock.invocationCallOrder[0];
    const saveCallOrder = mockStorageSave.mock.invocationCallOrder[0];
    expect(scanCallOrder).toBeLessThan(saveCallOrder);
  });

  test('un fichier infecté n\'est jamais écrit sur le stockage ni enregistré en base', async () => {
    const { VirusDetectedError } = require('../../src/modules/files/virusScan.service');
    mockAssertFileIsSafe.mockRejectedValue(new VirusDetectedError('EICAR-Test-Signature'));

    await expect(filesService.uploadFile('user-1', 'KYC_ID_DOCUMENT', makeFile())).rejects.toThrow(
      /signature virale détectée/
    );

    expect(mockStorageSave).not.toHaveBeenCalled();
    expect(mockPrisma.fileAsset.create).not.toHaveBeenCalled();
  });

  test('un scan indisponible (politique stricte) bloque aussi l\'upload sans rien écrire', async () => {
    const { ScanUnavailableError } = require('../../src/modules/files/virusScan.service');
    mockAssertFileIsSafe.mockRejectedValue(new ScanUnavailableError());

    await expect(filesService.uploadFile('user-1', 'KYC_ID_DOCUMENT', makeFile())).rejects.toThrow(
      /indisponible/
    );

    expect(mockStorageSave).not.toHaveBeenCalled();
  });

  test('un fichier propre suit normalement tout le flux (scan, stockage, puis enregistrement en base)', async () => {
    mockPrisma.fileAsset.create.mockResolvedValue({ id: 'file-2' });

    const result = await filesService.uploadFile('user-1', 'KYC_SELFIE', makeFile());

    expect(mockAssertFileIsSafe).toHaveBeenCalledWith(expect.any(Buffer));
    expect(mockStorageSave).toHaveBeenCalled();
    expect(mockPrisma.fileAsset.create).toHaveBeenCalled();
    expect(result).toEqual({ fileId: 'file-2', url: '/api/v1/files/file-2' });
  });

  test('ce qui est écrit sur le stockage est chiffré, jamais les octets d\'origine - et la ligne est marquée encryptedAtRest', async () => {
    mockPrisma.fileAsset.create.mockResolvedValue({ id: 'file-4' });
    const file = makeFile();

    await filesService.uploadFile('user-1', 'KYC_ID_DOCUMENT', file);

    const writtenBuffer = mockStorageSave.mock.calls[0][0];
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true);
    expect(writtenBuffer.equals(file.buffer)).toBe(false);
    expect(mockPrisma.fileAsset.create.mock.calls[0][0].data.encryptedAtRest).toBe(true);
  });

  test('le scan est appelé même pour un type de fichier valide (PDF)', async () => {
    mockPrisma.fileAsset.create.mockResolvedValue({ id: 'file-3' });

    await filesService.uploadFile('user-1', 'KYB_BUSINESS_DOCUMENT', makeFile({ mimetype: 'application/pdf' }));

    expect(mockAssertFileIsSafe).toHaveBeenCalled();
  });
});

describe('lecture - déchiffrement à la volée', () => {
  test('getFileForOwner renvoie le contenu d\'origine après un aller-retour chiffrement/déchiffrement réel', async () => {
    const { encryptBuffer } = require('../../src/utils/encryption');
    const original = Buffer.from('pièce d\'identité factice');
    mockPrisma.fileAsset.findUnique.mockResolvedValue({
      id: 'file-5',
      ownerUserId: 'user-1',
      mimeType: 'image/jpeg',
      storageKey: 'user-1/kyc_id_document/abc.jpeg',
      encryptedAtRest: true,
    });
    mockStorageRead.mockResolvedValue(encryptBuffer(original));

    const result = await filesService.getFileForOwner('file-5', 'user-1');

    expect(result.buffer.equals(original)).toBe(true);
  });

  test('rejette l\'accès si le fichier n\'appartient pas à l\'appelant', async () => {
    mockPrisma.fileAsset.findUnique.mockResolvedValue({ id: 'file-6', ownerUserId: 'quelqu-un-dautre' });

    await expect(filesService.getFileForOwner('file-6', 'user-1')).rejects.toThrow('Accès refusé');
    expect(mockStorageRead).not.toHaveBeenCalled();
  });

  test('un fichier pas encore migré (encryptedAtRest=false) est renvoyé tel quel, sans tenter de le déchiffrer', async () => {
    const legacyRaw = Buffer.from('ancien fichier écrit avant le chiffrement');
    mockPrisma.fileAsset.findUnique.mockResolvedValue({
      id: 'file-7',
      ownerUserId: 'user-1',
      mimeType: 'image/jpeg',
      storageKey: 'user-1/kyc_id_document/legacy.jpeg',
      encryptedAtRest: false,
    });
    mockStorageRead.mockResolvedValue(legacyRaw);

    const result = await filesService.getFileForOwner('file-7', 'user-1');

    expect(result.buffer.equals(legacyRaw)).toBe(true);
  });

  test('getFileForAdmin déchiffre aussi, sans vérifier de propriétaire', async () => {
    const { encryptBuffer } = require('../../src/utils/encryption');
    const original = Buffer.from('document entreprise factice');
    mockPrisma.fileAsset.findUnique.mockResolvedValue({
      id: 'file-8',
      mimeType: 'application/pdf',
      storageKey: 'biz-1/kyb_business_document/abc.pdf',
      encryptedAtRest: true,
    });
    mockStorageRead.mockResolvedValue(encryptBuffer(original));

    const result = await filesService.getFileForAdmin('file-8');

    expect(result.buffer.equals(original)).toBe(true);
  });
});

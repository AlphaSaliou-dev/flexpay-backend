const mockGetFileBuffer = jest.fn();
jest.mock('../../src/modules/files/files.service', () => ({
  getFileBuffer: (...args) => mockGetFileBuffer(...args),
}));

process.env.FACE_MATCH_PROVIDER = 'mock';
const { compareIdWithSelfie } = require('../../src/modules/kyc/faceMatch.service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('compareIdWithSelfie', () => {
  test('extrait correctement l\'id du fichier depuis l\'URL stockée', async () => {
    mockGetFileBuffer.mockResolvedValue({ buffer: Buffer.from('fake'), mimeType: 'image/jpeg' });

    await compareIdWithSelfie('/api/v1/files/abc-123', '/api/v1/files/def-456');

    expect(mockGetFileBuffer).toHaveBeenCalledWith('abc-123');
    expect(mockGetFileBuffer).toHaveBeenCalledWith('def-456');
  });

  test('sans fournisseur réel connecté, le résultat est toujours INCONCLUSIVE (jamais un faux positif)', async () => {
    mockGetFileBuffer.mockResolvedValue({ buffer: Buffer.from('fake'), mimeType: 'image/jpeg' });

    const result = await compareIdWithSelfie('/api/v1/files/abc-123', '/api/v1/files/def-456');

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.score).toBeNull();
  });
});

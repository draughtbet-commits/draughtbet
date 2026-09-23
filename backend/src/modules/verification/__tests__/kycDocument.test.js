import { jest } from '@jest/globals';

const mockPrisma = {
  verificationCase: { findFirst: jest.fn(), findUnique: jest.fn() },
  kycDocument: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn()
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma))
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  attachDocument,
  listMyDocuments,
  revokeDocument,
  listCaseDocuments,
  KycDocumentError,
  InvalidVerificationTypeError
} = await import('../service.js');

const sha = 'a'.repeat(64);

describe('KycDocument service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.kycDocument.findUnique.mockResolvedValue(null);
  });

  it('attaches a document to the in-flight case', async () => {
    mockPrisma.verificationCase.findFirst.mockResolvedValue({ id: 'vc-1' });
    mockPrisma.kycDocument.create.mockResolvedValue({
      id: 'doc-1',
      userId: 'u-1',
      verificationCaseId: 'vc-1',
      documentType: 'passport',
      objectKey: 'provider/x/y.png',
      mimeType: 'image/png',
      sizeBytes: BigInt(2048),
      sha256: sha,
      uploadedAt: new Date(),
      deletedAt: null
    });

    const doc = await attachDocument('u-1', {
      documentType: 'passport',
      objectKey: 'provider/x/y.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      sha256: sha
    });

    expect(mockPrisma.kycDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u-1',
        verificationCaseId: 'vc-1',
        documentType: 'passport',
        sizeBytes: BigInt(2048),
        sha256: sha
      })
    });
    expect(doc).toMatchObject({ id: 'doc-1', documentType: 'passport', sizeBytes: '2048' });
  });

  it('is idempotent for the same objectKey+sha256 and never re-creates a row', async () => {
    const row = {
      id: 'doc-1', userId: 'u-1', verificationCaseId: 'vc-1',
      documentType: 'national_id', objectKey: 'provider/a.png',
      mimeType: 'image/png', sizeBytes: BigInt(1024), sha256: sha,
      uploadedAt: new Date(), deletedAt: null
    };
    mockPrisma.kycDocument.findUnique.mockResolvedValue(row);

    const doc = await attachDocument('u-1', {
      documentType: 'national_id', objectKey: 'provider/a.png',
      mimeType: 'image/png', sizeBytes: 1024, sha256: sha
    });

    expect(mockPrisma.kycDocument.create).not.toHaveBeenCalled();
    expect(doc.id).toBe('doc-1');
  });

  it('rejects unsupported types, bad checksums and missing in-flight cases', async () => {
    await expect(
      attachDocument('u-1', { documentType: 'id_card', objectKey: 'k', mimeType: 'x', sizeBytes: 10, sha256: sha })
    ).rejects.toBeInstanceOf(InvalidVerificationTypeError);

    await expect(
      attachDocument('u-1', { documentType: 'passport', objectKey: 'k', mimeType: 'x', sizeBytes: 10, sha256: 'zzz' })
    ).rejects.toBeInstanceOf(KycDocumentError);

    mockPrisma.verificationCase.findFirst.mockResolvedValue(null);
    await expect(
      attachDocument('u-1', { documentType: 'passport', objectKey: 'k', mimeType: 'x', sizeBytes: 10, sha256: sha })
    ).rejects.toThrow('No verification case in progress');
  });

  it('lists only the player active documents and soft-revokes owned ones', async () => {
    mockPrisma.kycDocument.findMany.mockResolvedValue([
      { id: 'doc-1', documentType: 'passport', objectKey: 'k1', mimeType: 'image/png',
        sizeBytes: BigInt(100), sha256: sha, uploadedAt: new Date(), deletedAt: null }
    ]);
    const docs = await listMyDocuments('u-1');
    expect(docs).toHaveLength(1);
    expect(mockPrisma.kycDocument.findMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', deletedAt: null },
      orderBy: { uploadedAt: 'desc' }
    });

    mockPrisma.kycDocument.updateMany.mockResolvedValue({ count: 1 });
    await expect(revokeDocument('u-1', 'doc-1')).resolves.toEqual({ revoked: true });
    expect(mockPrisma.kycDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', userId: 'u-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) }
    });

    mockPrisma.kycDocument.updateMany.mockResolvedValue({ count: 0 });
    await expect(revokeDocument('u-1', 'other-1')).rejects.toThrow('Document not found');
  });

  it('returns case evidence with revoked flag for admin reads', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({ id: 'vc-1', userId: 'u-1', status: 'PENDING' });
    mockPrisma.kycDocument.findMany.mockResolvedValue([
      { id: 'doc-1', documentType: 'passport', objectKey: 'k1', mimeType: 'image/png',
        sizeBytes: BigInt(100), sha256: sha, uploadedAt: new Date(), deletedAt: new Date() }
    ]);

    const result = await listCaseDocuments('vc-1');
    expect(result.case).toEqual({ id: 'vc-1', userId: 'u-1', status: 'PENDING' });
    expect(result.documents[0]).toMatchObject({ id: 'doc-1', deleted: true });
  });
});
import { jest } from '@jest/globals';
import crypto from 'node:crypto';

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: {
    devicePushToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn()
    }
  }
}));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const tokenHash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const mockPrisma = (await import('../../../utils/db.js')).default;

const {
  registerPushToken,
  listPushTokens,
  revokePushToken,
  decryptToken,
  PushTokenError
} = await import('../pushTokenService.js');

const KEY = 'a'.repeat(64);
const ORIGINAL_KEY = process.env.PUSH_TOKEN_ENCRYPTION_KEY;

describe('pushTokenService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PUSH_TOKEN_ENCRYPTION_KEY = KEY;
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.PUSH_TOKEN_ENCRYPTION_KEY;
    else process.env.PUSH_TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it('creates an encrypted row and never stores the plaintext token', async () => {
    mockPrisma.devicePushToken.findUnique.mockResolvedValue(null);
    mockPrisma.devicePushToken.create.mockResolvedValue({
      id: 'tok-1',
      userId: 'u-1',
      tokenHash: tokenHash('raw-push-token'),
      tokenCiphertext: 'cipher',
      platform: 'ios',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null
    });

    const view = await registerPushToken('u-1', { token: 'raw-push-token', platform: 'ios' });

    const createCall = mockPrisma.devicePushToken.create.mock.calls[0][0].data;
    expect(createCall.tokenHash).toBe(tokenHash('raw-push-token'));
    expect(createCall.tokenCiphertext).not.toContain('raw-push-token');
    expect(createCall.tokenCiphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decryptToken(createCall.tokenCiphertext, KEY)).toBe('raw-push-token');
    expect(decryptToken(createCall.tokenCiphertext)).toBe('raw-push-token');
    expect(view.platform).toBe('ios');
  });

  it('reactivates an existing token for the same owner (idempotent)', async () => {
    mockPrisma.devicePushToken.findUnique.mockResolvedValue({
      id: 'tok-1', userId: 'u-1', platform: 'web', active: false, revokedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(), tokenHash: tokenHash('t'), tokenCiphertext: 'x'
    });
    mockPrisma.devicePushToken.update.mockResolvedValue({
      id: 'tok-1', userId: 'u-1', platform: 'android', active: true, revokedAt: null,
      createdAt: new Date(), updatedAt: new Date()
    });

    const view = await registerPushToken('u-1', { token: 't', platform: 'android' });

    expect(mockPrisma.devicePushToken.update).toHaveBeenCalled();
    expect(mockPrisma.devicePushToken.create).not.toHaveBeenCalled();
    expect(view.active).toBe(true);
    expect(view.revokedAt).toBeNull();
  });

  it('rejects invalid platforms and a missing encryption key', async () => {
    await expect(
      registerPushToken('u-1', { token: 'x', platform: 'desktop' })
    ).rejects.toBeInstanceOf(PushTokenError);

    delete process.env.PUSH_TOKEN_ENCRYPTION_KEY;
    mockPrisma.devicePushToken.findUnique.mockResolvedValue(null);
    await expect(
      registerPushToken('u-1', { token: 'x', platform: 'ios' })
    ).rejects.toBeInstanceOf(PushTokenError);
  });

  it('lists only metadata for the owner and revokes scoped tokens', async () => {
    mockPrisma.devicePushToken.findMany.mockResolvedValue([
      { id: 'tok-1', platform: 'ios', active: true, createdAt: new Date(), updatedAt: new Date(), revokedAt: null }
    ]);
    const tokens = await listPushTokens('u-1');
    expect(tokens).toHaveLength(1);
    expect(mockPrisma.devicePushToken.findMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', active: true },
      orderBy: { createdAt: 'desc' },
      select: expect.any(Object)
    });

    mockPrisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });
    await expect(revokePushToken('u-1', 'tok-1')).resolves.toEqual({ revoked: true });

    mockPrisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(revokePushToken('u-1', 'missing')).rejects.toThrow('Push token not found');
  });
});
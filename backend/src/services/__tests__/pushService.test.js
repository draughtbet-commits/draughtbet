import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  devicePushToken: {
    findMany: jest.fn(),
    updateMany: jest.fn()
  }
};
const mockDecryptToken = jest.fn((ciphertext) => `token:${ciphertext}`);
const sendMock = jest.fn();

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../modules/me/pushTokenService.js', () => ({
  decryptToken: mockDecryptToken
}));

const appObj = { name: 'draughtbet-push' };
const initializeAppMock = jest.fn(() => appObj);
const messagingMock = jest.fn(() => ({ send: sendMock }));
jest.unstable_mockModule('firebase-admin', () => ({
  default: {
    apps: [],
    initializeApp: initializeAppMock,
    app: jest.fn(() => appObj),
    credential: { cert: jest.fn((c) => ({ cert: c })) },
    messaging: messagingMock
  }
}));

const { isPushConfigured, sendToUser, __resetPushForTests } = await import(
  '../pushService.js'
);

const validCreds = JSON.stringify({
  project_id: 'draughtbet-test',
  client_email: 'push@draughtbet-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n'
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  __resetPushForTests();
});

describe('pushService configuration', () => {
  it('is disabled when the service-account key is missing', () => {
    expect(isPushConfigured()).toBe(false);
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it('initializes from raw JSON service-account credentials', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCreds;

    expect(isPushConfigured()).toBe(true);
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(messagingMock).toHaveBeenCalled();
  });

  it('accepts base64-encoded credentials (newline-safe in an env var)', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = Buffer.from(validCreds).toString('base64');

    expect(isPushConfigured()).toBe(true);
  });

  it('stays disabled when the credentials are malformed', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{ not json';

    expect(isPushConfigured()).toBe(false);
    expect(initializeAppMock).not.toHaveBeenCalled();
  });
});

describe('sendToUser', () => {
  it('skips cleanly when FCM is not configured', async () => {
    const result = await sendToUser('user-1', { title: 'Hi', body: 'There' });

    expect(result).toEqual({ configured: false, sent: 0, failed: 0, skipped: 0 });
    expect(mockPrisma.devicePushToken.findMany).not.toHaveBeenCalled();
  });

  it('sends to every active token and reports the count', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCreds;
    mockPrisma.devicePushToken.findMany.mockResolvedValue([
      { id: 't1', tokenCiphertext: 'c1' },
      { id: 't2', tokenCiphertext: 'c2' }
    ]);
    sendMock.mockResolvedValue('ok');

    const result = await sendToUser('user-1', {
      title: 'Match ready',
      body: 'Your opponent joined',
      data: { matchId: 'm-1', link: '/matches/m-1' }
    });

    expect(result).toEqual({ configured: true, sent: 2, failed: 0, skipped: 0 });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const firstCall = sendMock.mock.calls[0][0];
    expect(firstCall.token).toBe('token:c1');
    expect(firstCall.notification.body).toBe('Your opponent joined');
    // data values must be strings for FCM
    expect(firstCall.data).toEqual({ matchId: 'm-1', link: '/matches/m-1' });
  });

  it('deactivates tokens FCM reports as dead', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCreds;
    mockPrisma.devicePushToken.findMany.mockResolvedValue([
      { id: 't1', tokenCiphertext: 'c1' },
      { id: 't2', tokenCiphertext: 'c2' }
    ]);
    mockPrisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });
    sendMock
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce({ code: 'messaging/registration-token-not-registered' });

    const result = await sendToUser('user-1', { title: 'x', body: 'y' });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(mockPrisma.devicePushToken.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t2'] } },
      data: { active: false, revokedAt: expect.any(Date) }
    });
  });

  it('keeps a token on a transient failure', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCreds;
    mockPrisma.devicePushToken.findMany.mockResolvedValue([
      { id: 't1', tokenCiphertext: 'c1' }
    ]);
    sendMock.mockRejectedValueOnce({ code: 'messaging/internal-error' });

    const result = await sendToUser('user-1', { title: 'x', body: 'y' });

    expect(result.failed).toBe(1);
    expect(mockPrisma.devicePushToken.updateMany).not.toHaveBeenCalled();
  });

  it('never throws when a token cannot be decrypted', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCreds;
    mockPrisma.devicePushToken.findMany.mockResolvedValue([
      { id: 't1', tokenCiphertext: 'c1' }
    ]);
    mockDecryptToken.mockImplementationOnce(() => {
      throw new Error('bad ciphertext');
    });

    const result = await sendToUser('user-1', { title: 'x', body: 'y' });

    expect(result.failed).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

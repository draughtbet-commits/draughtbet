import { jest, describe, it, expect } from '@jest/globals';

const mockPrisma = {
  depositIntent: {
    findUnique: jest.fn(),
    update: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { findDepositIntentByClientKey } = await import('../service.js');

describe('Wallet service — deposit idempotent replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null for a missing key without touching the database', async () => {
    await expect(findDepositIntentByClientKey('user-1', null)).resolves.toBeNull();
    await expect(findDepositIntentByClientKey('user-1', undefined)).resolves.toBeNull();
    expect(mockPrisma.depositIntent.findUnique).not.toHaveBeenCalled();
  });

  it('replays a PENDING intent untouched so the client keeps its checkout', async () => {
    const pending = {
      id: 'intent-1',
      status: 'PENDING',
      authorizationUrl: 'https://pay.example.com/checkout/abc'
    };
    mockPrisma.depositIntent.findUnique.mockResolvedValue(pending);

    await expect(findDepositIntentByClientKey('user-1', 'key_1')).resolves.toBe(pending);
    expect(mockPrisma.depositIntent.update).not.toHaveBeenCalled();
  });

  it('replays a COMPLETED intent untouched', async () => {
    const completed = {
      id: 'intent-2',
      status: 'COMPLETED',
      authorizationUrl: 'https://pay.example.com/checkout/def'
    };
    mockPrisma.depositIntent.findUnique.mockResolvedValue(completed);

    await expect(findDepositIntentByClientKey('user-1', 'key_1')).resolves.toBe(completed);
    expect(mockPrisma.depositIntent.update).not.toHaveBeenCalled();
  });

  it('never replays a FAILED intent and frees the key for a retry', async () => {
    // A FAILED intent never exposed a checkout, so handing its (null)
    // authorizationUrl back left the client stuck on "secure checkout is not
    // available" for that quote. It must be retired instead.
    mockPrisma.depositIntent.findUnique.mockResolvedValue({
      id: 'intent-3',
      status: 'FAILED',
      authorizationUrl: null
    });
    mockPrisma.depositIntent.update.mockResolvedValue({});

    await expect(findDepositIntentByClientKey('user-1', 'key_1')).resolves.toBeNull();

    expect(mockPrisma.depositIntent.update).toHaveBeenCalledWith({
      where: { id: 'intent-3' },
      data: { clientIdempotencyKey: 'key_1:superseded:intent-3' }
    });
  });

  it('keeps the retired row queryable instead of deleting it', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue({
      id: 'intent-4',
      status: 'FAILED',
      authorizationUrl: null
    });
    mockPrisma.depositIntent.update.mockResolvedValue({});

    await findDepositIntentByClientKey('user-1', 'key_1');

    expect(mockPrisma.depositIntent.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.depositIntent.delete).toBeUndefined();
  });
});
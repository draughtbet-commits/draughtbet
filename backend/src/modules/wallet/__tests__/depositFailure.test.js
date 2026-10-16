import { jest } from '@jest/globals';

const mockPrisma = {
  depositIntent: { findUnique: jest.fn(), updateMany: jest.fn() },
  notification: { create: jest.fn() },
  outboxEvent: {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'ob-1' }))
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma))
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { processDepositFailure } = await import('../service.js');

const intent = (overrides = {}) => ({
  id: 'intent-1',
  reference: 'ref-1',
  userId: 'user-1',
  gateway: 'PAYSTACK',
  status: 'PENDING',
  amountMinorUnits: 50000n,
  currency: 'NGN',
  ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.outboxEvent.findUnique.mockResolvedValue(null);
  mockPrisma.outboxEvent.create.mockResolvedValue({ id: 'ob-1' });
  mockPrisma.notification.create.mockImplementation(async ({ data }) => ({ id: 'notif-1', ...data }));
  mockPrisma.depositIntent.updateMany.mockResolvedValue({ count: 1 });
});

describe('processDepositFailure', () => {
  it('parks a PENDING intent FAILED and creates a DEPOSIT_FAILED notification atomically', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent());

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK', userId: 'user-1' });

    expect(result).toMatchObject({ handled: true, alreadyApplied: false });
    expect(mockPrisma.depositIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'intent-1', status: 'PENDING' },
      data: { status: 'FAILED' }
    });
    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'DEPOSIT_FAILED',
        title: 'Deposit Not Completed',
        message: expect.stringContaining('₦500.00')
      })
    });
    // Durable delivery row enqueued in the same tx.
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown reference without notifying', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(null);

    const result = await processDepositFailure({ reference: 'ghost', gateway: 'PAYSTACK' });

    expect(result).toEqual({ handled: false, reason: 'UNKNOWN_REFERENCE' });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('ignores a missing reference', async () => {
    const result = await processDepositFailure({ gateway: 'PAYSTACK' });
    expect(result).toEqual({ handled: false, reason: 'UNKNOWN_REFERENCE' });
    expect(mockPrisma.depositIntent.findUnique).not.toHaveBeenCalled();
  });

  it('never notifies failure for an already-credited (COMPLETED) intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent({ status: 'COMPLETED' }));

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK' });

    expect(result).toMatchObject({ handled: false, alreadyApplied: true });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.depositIntent.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-FAILED intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent({ status: 'FAILED' }));

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK' });

    expect(result).toMatchObject({ handled: false, alreadyApplied: true });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('rejects a gateway mismatch', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent({ gateway: 'FLUTTERWAVE' }));

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK' });

    expect(result).toEqual({ handled: false, reason: 'GATEWAY_MISMATCH' });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('rejects a user mismatch', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent());

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK', userId: 'someone-else' });

    expect(result).toEqual({ handled: false, reason: 'USER_MISMATCH' });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('does not double-notify when the CAS loses the race', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(intent());
    mockPrisma.depositIntent.updateMany.mockResolvedValue({ count: 0 });

    const result = await processDepositFailure({ reference: 'ref-1', gateway: 'PAYSTACK' });

    expect(result).toMatchObject({ handled: false, alreadyApplied: true });
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

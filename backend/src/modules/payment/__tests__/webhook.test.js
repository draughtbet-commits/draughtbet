import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { processDepositWebhook } = await import('../../wallet/service.js');

describe('Deposit Webhook Processing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process a valid webhook, credit wallet, and write transaction', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => {
      return await cb(mockPrisma);
    });

    mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1' });
    mockPrisma.walletTransaction.create.mockResolvedValue({ walletId: 'wallet-1' });

    const result = await processDepositWebhook('paystack-ref-123', 50000, 'PAYSTACK', 'user-1');
    expect(result).toBe(true);

    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gatewayReference: 'paystack-ref-123',
        amountMinorUnits: BigInt(50000),
        gateway: 'PAYSTACK'
      })
    });
  });

  it('should ignore duplicate webhooks with the same reference (P2002 Idempotency)', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => {
      // Simulate P2002 thrown during transaction
      const error = new Error('Unique constraint failed');
      error.code = 'P2002';
      throw error;
    });

    // It should catch the error and return true
    const result = await processDepositWebhook('paystack-ref-dup', 50000, 'PAYSTACK', 'user-1');
    expect(result).toBe(true);
  });
});

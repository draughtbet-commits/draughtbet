import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn()
  },
  withdrawalRequest: {
    create: jest.fn(),
    findUnique: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { requestWithdrawal, rejectWithdrawal } = await import('../service.js');

describe('Wallet Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('requestWithdrawal', () => {
    it('should deduct balance and create a PENDING withdrawal request', async () => {
      const amount = 100000; // 1000 NGN
      
      // Setup transaction mock to just execute the callback
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });

      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: BigInt(500000) });
      mockPrisma.withdrawalRequest.create.mockResolvedValue({ id: 'req-1', status: 'PENDING', amountMinorUnits: BigInt(amount) });

      const req = await requestWithdrawal('user-1', amount);
      
      expect(req.status).toBe('PENDING');
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { balanceMinorUnits: { decrement: BigInt(amount) } }
      });
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'WITHDRAWAL', amountMinorUnits: -BigInt(amount) })
      });
    });

    it('should throw InsufficientFundsError if balance is too low', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: BigInt(50000) });

      await expect(requestWithdrawal('user-1', 100000)).rejects.toThrow('Insufficient funds');
    });
  });

  describe('rejectWithdrawal', () => {
    it('should refund balance, mark REJECTED, and write REFUND tx atomically', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      
      mockPrisma.withdrawalRequest.findUnique.mockResolvedValue({ id: 'req-1', userId: 'user-1', amountMinorUnits: BigInt(100000) });
      mockPrisma.$executeRaw.mockResolvedValue(1); // 1 row updated (was PENDING)
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });

      const result = await rejectWithdrawal('req-1', 'admin-1');
      expect(result).toBe(true);

      // Verify credit
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { balanceMinorUnits: { increment: BigInt(100000) } }
      });

      // Verify REFUND tx
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'REFUND', amountMinorUnits: BigInt(100000) })
      });
    });

    it('should be idempotent and not double-refund if already REJECTED', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      
      mockPrisma.withdrawalRequest.findUnique.mockResolvedValue({ id: 'req-1', userId: 'user-1', amountMinorUnits: BigInt(100000) });
      mockPrisma.$executeRaw.mockResolvedValue(0); // 0 rows updated (was NOT PENDING)

      const result = await rejectWithdrawal('req-1', 'admin-1');
      expect(result).toBeNull(); // Second attempt should return null
      
      // Should not have credited wallet
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });
  });
});

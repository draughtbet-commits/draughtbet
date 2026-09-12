import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
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
    findUnique: jest.fn(),
    findFirst: jest.fn()
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
    it('should lock the wallet, deduct balance, and create a PENDING withdrawal request', async () => {
      const amount = 100000; // 1000 NGN

      // Setup transaction mock to just execute the callback
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });

      // lockWalletForUpdate returns the wallet row from FOR UPDATE query
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '500000' }]);
      mockPrisma.withdrawalRequest.create.mockResolvedValue({ id: 'req-1', status: 'PENDING', amountMinorUnits: BigInt(amount) });

      const req = await requestWithdrawal('user-1', amount);

      expect(req.status).toBe('PENDING');
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockPrisma.withdrawalRequest.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { balanceMinorUnits: { decrement: BigInt(amount) } }
      });
      expect(mockPrisma.withdrawalRequest.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', amountMinorUnits: BigInt(amount), status: 'PENDING' }
      });
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'WITHDRAWAL', amountMinorUnits: -BigInt(amount) })
      });
    });

    it('should throw InsufficientFundsError if balance is too low and not debit', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '50000' }]);

      await expect(requestWithdrawal('user-1', 100000)).rejects.toThrow('Insufficient funds');
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('should reject invalid amounts without touching the wallet', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '500000' }]);

      await expect(requestWithdrawal('user-1', 0)).rejects.toThrow('Invalid amount');
      await expect(requestWithdrawal('user-1', '100.50')).rejects.toThrow('Invalid amount');
      await expect(requestWithdrawal('user-1', -50)).rejects.toThrow('Invalid amount');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should return the existing request on idempotent replay instead of re-debiting', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '500000' }]);
      mockPrisma.withdrawalRequest.findFirst.mockResolvedValue({ id: 'req-original', status: 'PENDING', amountMinorUnits: BigInt(100000) });

      const req = await requestWithdrawal('user-1', 100000, 'op_key_abcdef');

      expect(req.id).toBe('req-original');
      expect(mockPrisma.withdrawalRequest.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1', idempotencyKey: 'op_key_abcdef' }
      });
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(mockPrisma.withdrawalRequest.create).not.toHaveBeenCalled();
    });

    it('should resolve a (userId, idempotencyKey) unique-constraint race to the winner', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '500000' }]);
      const winner = { id: 'req-winner', status: 'PENDING', amountMinorUnits: BigInt(100000) };
      // In-tx replay check sees nothing; the CREATE hits the unique index (P2002),
      // rolling back our debit; the outer reconciler returns the winner.
      mockPrisma.withdrawalRequest.findFirst.mockResolvedValueOnce(undefined).mockResolvedValue(winner);
      mockPrisma.withdrawalRequest.create.mockRejectedValue({ code: 'P2002' });

      const req = await requestWithdrawal('user-1', 100000, 'op_key_abcdef');

      expect(req.id).toBe('req-winner');
      expect(mockPrisma.withdrawalRequest.findFirst).toHaveBeenCalledTimes(2);
      expect(mockPrisma.withdrawalRequest.findFirst).toHaveBeenLastCalledWith({
        where: { userId: 'user-1', idempotencyKey: 'op_key_abcdef' }
      });
    });

    it('should reject malformed idempotency keys', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        return await cb(mockPrisma);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', balanceMinorUnits: '500000' }]);

      await expect(requestWithdrawal('user-1', 100000, 'short')).rejects.toThrow('Invalid idempotency key');
      await expect(requestWithdrawal('user-1', 100000, 'has space keys')).rejects.toThrow('Invalid idempotency key');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
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

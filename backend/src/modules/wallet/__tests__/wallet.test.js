import { jest, describe, it, expect } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  wallet: {
    findUnique: jest.fn()
  },
  walletTransaction: {
    findMany: jest.fn(),
    count: jest.fn()
  },
  depositIntent: {
    create: jest.fn()
  },
  user: {
    findUnique: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { parseMinorUnits, parseIdempotencyKey, parseDecimalMajorToMinor, createDepositIntent } = await import('../service.js');

describe('Wallet service — canonical money + deposit-intent gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseMinorUnits', () => {
    it('accepts positive integer minor units as string or number', () => {
      expect(parseMinorUnits('50000')).toBe(50000n);
      expect(parseMinorUnits(50000)).toBe(50000n);
      expect(parseMinorUnits('00100')).toBe(100n);
    });

    it('rejects floats, signs, exponent notation, empty and zero', () => {
      expect(parseMinorUnits('100.50')).toBeNull();
      expect(parseMinorUnits('-50')).toBeNull();
      expect(parseMinorUnits('1e3')).toBeNull();
      expect(parseMinorUnits('')).toBeNull();
      expect(parseMinorUnits(0)).toBeNull();
      expect(parseMinorUnits(-5)).toBeNull();
      expect(parseMinorUnits(null)).toBeNull();
      expect(parseMinorUnits(undefined)).toBeNull();
    });
  });

  describe('parseDecimalMajorToMinor', () => {
    it('converts major decimals to minor units with exact string math', () => {
      expect(parseDecimalMajorToMinor('1250.00')).toBe(125000n);
      expect(parseDecimalMajorToMinor('1250')).toBe(125000n);
      expect(parseDecimalMajorToMinor('0.50')).toBe(50n);
    });

    it('rejects malformed or non-positive values', () => {
      expect(parseDecimalMajorToMinor('1.234')).toBeNull();
      expect(parseDecimalMajorToMinor('-1.00')).toBeNull();
      expect(parseDecimalMajorToMinor('abc')).toBeNull();
      expect(parseDecimalMajorToMinor('0.00')).toBeNull();
    });
  });

  describe('parseIdempotencyKey', () => {
    it('returns undefined for missing keys and accepts valid ones', () => {
      expect(parseIdempotencyKey(undefined)).toBeUndefined();
      expect(parseIdempotencyKey('')).toBeUndefined();
      expect(parseIdempotencyKey(null)).toBeUndefined();
      expect(parseIdempotencyKey('op_key_abcdef')).toBe('op_key_abcdef');
    });

    it('rejects malformed keys', () => {
      expect(() => parseIdempotencyKey('short')).toThrow(/Invalid idempotency key/i);
      expect(() => parseIdempotencyKey('has space keys')).toThrow(/Invalid idempotency key/i);
      expect(() => parseIdempotencyKey(12345)).toThrow(/Invalid idempotency key/i);
    });
  });

  describe('createDepositIntent', () => {
    beforeEach(() => {
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w-1', userId: 'u-1', currency: 'NGN' });
      mockPrisma.depositIntent.create.mockImplementation(({ data }) => ({ id: 'i-1', ...data }));
    });

    it('rejects invalid amount before any DB call', async () => {
      await expect(createDepositIntent('u-1', '100.50', 'PAYSTACK', 'e@x.com')).rejects.toThrow('Invalid amount');
      await expect(createDepositIntent('u-1', 0, 'PAYSTACK', 'e@x.com')).rejects.toThrow('Invalid amount');
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
    });

    it('rejects unknown gateways', async () => {
      await expect(createDepositIntent('u-1', 5000n, 'STRIPE', 'e@x.com')).rejects.toThrow('Invalid gateway');
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
    });

    it('rejects wallets without NGN (Phase 1 deposits)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w-1', userId: 'u-1', currency: 'GBP' });
      await expect(createDepositIntent('u-1', 5000n, 'PAYSTACK', 'e@x.com')).rejects.toThrow('Deposits are only supported for NGN wallets');
    });

    it('creates a server-owned intent with a generated reference', async () => {
      const intent = await createDepositIntent('u-1', 5000n, 'PAYSTACK', 'e@x.com');
      expect(intent.id).toBe('i-1');
      expect(intent.reference).toMatch(/^paystack-/);
      expect(mockPrisma.depositIntent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u-1',
          walletId: 'w-1',
          gateway: 'PAYSTACK',
          amountMinorUnits: 5000n,
          currency: 'NGN'
        })
      });
    });
  });
});
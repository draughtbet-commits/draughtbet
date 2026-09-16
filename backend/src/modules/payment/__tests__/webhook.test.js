import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  depositIntent: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn()
  },
  ledgerAccount: {
    upsert: jest.fn()
  },
  ledgerTransaction: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  ledgerEntry: {
    create: jest.fn()
  },
  outboxEvent: {
    create: jest.fn()
  },
  notification: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { processDepositWebhook, parseDecimalMajorToMinor, createDepositIntent } =
  await import('../../wallet/service.js');

const INTENT = {
  id: 'intent-1',
  userId: 'user-1',
  walletId: 'wallet-1',
  gateway: 'PAYSTACK',
  reference: 'paystack-ref-123',
  amountMinorUnits: BigInt(50000),
  currency: 'NGN',
  status: 'PENDING'
};

describe('Deposit Webhook Processing (stored-intent verified)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    // User + system ledger accounts resolve to deterministic ids keyed by type.
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ create }) => ({
      id: create?.type === 'CUSTOMER_LIABILITY'
        ? `system:${create.type}:${create.currency}`
        : `acc-${create?.type}`,
      ...create
    }));
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockImplementation(async (data) => ({
      id: 'ltx-1',
      ...data.data
    }));
    mockPrisma.ledgerEntry.create.mockImplementation(async ({ data }) => ({
      id: `entry-${data.accountId}`,
      ...data
    }));
  });

  it('credits exactly the stored intent amount and marks the intent applied', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);
    mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1', currency: 'NGN' });
    mockPrisma.walletTransaction.create.mockResolvedValue({ walletId: 'wallet-1', amountMinorUnits: BigInt(50000) });

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result.handled).toBe(true);
    expect(result.alreadyApplied).toBe(false);
    // Credit comes from the intent, not the webhook body.
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gatewayReference: 'paystack-ref-123',
        amountMinorUnits: BigInt(50000),
        gateway: 'PAYSTACK',
        type: 'DEPOSIT'
      })
    });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balanceMinorUnits: { increment: BigInt(50000) } }
    });
    expect(mockPrisma.depositIntent.update).toHaveBeenCalledWith({
      where: { id: 'intent-1' },
      data: expect.objectContaining({ status: 'COMPLETED' })
    });
    // The V2 ledger mirror posts in the same transaction, idempotent per
    // reference, and balances to zero (liability -50000 / available +50000).
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'DEPOSIT_CREDIT',
        idempotencyKey: 'deposit:credit:paystack-ref-123'
      })
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        accountId: 'system:CUSTOMER_LIABILITY:NGN',
        amountMinorUnits: BigInt(-50000)
      })
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        accountId: 'acc-PLAYER_AVAILABLE',
        amountMinorUnits: BigInt(50000)
      })
    });
    // Durable wallet.updated outbox row + notification, atomic with the credit.
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'Wallet',
        aggregateId: 'wallet-1',
        eventType: 'wallet.updated'
      })
    });
    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'DEPOSIT_CONFIRMED'
      })
    });
  });

  it('treats an already-applied intent as a duplicate and does not re-credit', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue({ ...INTENT, status: 'COMPLETED' });

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result.handled).toBe(false);
    expect(result.alreadyApplied).toBe(true);
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('converts a concurrent duplicate delivery (P2002) into already-applied without re-credit', async () => {
    const error = new Error('Unique constraint failed');
    error.code = 'P2002';
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);
    mockPrisma.walletTransaction.create.mockRejectedValue(error);

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result.alreadyApplied).toBe(true);
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown reference without any credit', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(null);

    const result = await processDepositWebhook({
      reference: 'unknown-ref',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result).toMatchObject({ handled: false, reason: 'UNKNOWN_REFERENCE' });
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects an amount that differs from the stored intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 99999,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result).toMatchObject({ handled: false, reason: 'AMOUNT_MISMATCH' });
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects a webhook claiming a different user than the intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'attacker-9'
    });

    expect(result).toMatchObject({ handled: false, reason: 'USER_MISMATCH' });
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects an event whose currency does not match the wallet/intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);
    mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1', currency: 'NGN' });

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'USD',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result).toMatchObject({ handled: false, reason: 'CURRENCY_MISMATCH' });
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects an event whose gateway does not match the intent', async () => {
    mockPrisma.depositIntent.findUnique.mockResolvedValue(INTENT);

    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'FLUTTERWAVE',
      userId: 'user-1'
    });

    expect(result).toMatchObject({ handled: false, reason: 'GATEWAY_MISMATCH' });
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical webhook amount (float junk) without querying the intent', async () => {
    const result = await processDepositWebhook({
      reference: 'paystack-ref-123',
      amountMinorUnits: '50.5.1',
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });

    expect(result).toMatchObject({ handled: false, reason: 'AMOUNT_MISMATCH' });
    expect(mockPrisma.depositIntent.findUnique).not.toHaveBeenCalled();
  });

  it('createDepositIntent refuses a float amount before persisting anything', async () => {
    await expect(createDepositIntent('user-1', 50.5, 'PAYSTACK')).rejects.toThrow('Invalid amount');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('createDepositIntent rejects unsupported gateways', async () => {
    await expect(createDepositIntent('user-1', 50000, 'STRIPE')).rejects.toThrow('Invalid gateway');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('parseDecimalMajorToMinor (exact, float-free)', () => {
  it('parses major-unit decimals exactly to integer minor units', () => {
    expect(parseDecimalMajorToMinor('1250')).toBe(BigInt(125000));
    expect(parseDecimalMajorToMinor('1250.5')).toBe(BigInt(125050));
    expect(parseDecimalMajorToMinor('0.01')).toBe(BigInt(1));
    expect(parseDecimalMajorToMinor(5000)).toBe(BigInt(500000));
    expect(parseDecimalMajorToMinor('0.99')).toBe(BigInt(99));
  });

  it('rejects malformed or over-precision values', () => {
    expect(parseDecimalMajorToMinor('12.345')).toBeNull();
    expect(parseDecimalMajorToMinor('abc')).toBeNull();
    expect(parseDecimalMajorToMinor('1,000')).toBeNull();
    expect(parseDecimalMajorToMinor('-5')).toBeNull();
    expect(parseDecimalMajorToMinor('1e3')).toBeNull();
    expect(parseDecimalMajorToMinor(0)).toBeNull();
  });
});
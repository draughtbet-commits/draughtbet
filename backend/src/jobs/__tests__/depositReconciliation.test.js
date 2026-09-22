import { jest } from '@jest/globals';

const mockPrisma = {
  depositIntent: {
    updateMany: jest.fn(),
    findMany: jest.fn()
  },
  ledgerTransaction: {
    findUnique: jest.fn()
  },
  ledgerEntry: {
    findFirst: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const logger = (await import('../../utils/logger.js')).default;
jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});

const {
  reconcileDeposits,
  STALE_DEPOSIT_HOURS
} = await import('../depositReconciliation.js');

const COMPLETED = {
  id: 'intent-1',
  userId: 'user-1',
  walletId: 'wallet-1',
  reference: 'paystack-ref-123',
  amountMinorUnits: BigInt(50000),
  status: 'COMPLETED'
};

const FAILED = {
  id: 'intent-2',
  userId: 'user-2',
  walletId: 'wallet-2',
  reference: 'flutterwave-ref-456',
  amountMinorUnits: BigInt(25000),
  status: 'FAILED'
};

describe('depositReconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.depositIntent.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.ledgerEntry.findFirst.mockResolvedValue({
      amountMinorUnits: BigInt(50000)
    });
  });

  it('parks stale PENDING intents as FAILED (missed webhook), nothing else touched', async () => {
    mockPrisma.depositIntent.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.depositIntent.findMany.mockResolvedValue([]);

    const summary = await reconcileDeposits();

    expect(summary).toEqual({ staleParked: 3, intentsChecked: 0, anomalies: [] });
    expect(mockPrisma.depositIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING', createdAt: { lt: expect.any(Date) } }),
        data: { status: 'FAILED' }
      })
    );
  });

  it('does not run concurrently (re-entrancy guard)', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    mockPrisma.depositIntent.updateMany.mockImplementation(() => gate);
    mockPrisma.depositIntent.findMany.mockResolvedValue([]);

    const first = reconcileDeposits();
    const second = await reconcileDeposits();
    expect(second).toBeNull();

    release({ count: 0 });
    await first;
    const third = await reconcileDeposits();
    expect(third).not.toBeNull();
  });

  it('flags a COMPLETED intent missing its ledger posting (never repairs)', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.depositIntent.findMany.mockResolvedValue([COMPLETED]);

    const summary = await reconcileDeposits();

    expect(summary.anomalies).toHaveLength(1);
    expect(summary.anomalies[0]).toMatchObject({
      intentId: 'intent-1',
      check: 'ledgerPostingMissing'
    });
    // No repair happened: nothing re-credits or creates rows.
    expect(mockPrisma.ledgerTransaction.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'deposit:credit:paystack-ref-123' },
      include: { entries: true }
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('flags a COMPLETED intent whose ledger credit does not match the intent amount', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      id: 'ltx-1',
      type: 'DEPOSIT_CREDIT',
      entries: []
    });
    mockPrisma.ledgerEntry.findFirst.mockResolvedValue({
      amountMinorUnits: BigInt(49999)
    });
    mockPrisma.depositIntent.findMany.mockResolvedValue([COMPLETED]);

    const summary = await reconcileDeposits();

    expect(summary.anomalies[0].check).toBe('ledgerAmount');
  });

  it('flags a FAILED intent that somehow has a ledger credit', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      id: 'ltx-2',
      type: 'DEPOSIT_CREDIT'
    });
    mockPrisma.depositIntent.findMany.mockResolvedValue([FAILED]);

    const summary = await reconcileDeposits();

    expect(summary.anomalies[0].check).toBe('failedIntentHasCredit');
  });

  it('is healthy when every COMPLETED intent has exactly one ledger credit', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      id: 'ltx-1',
      type: 'DEPOSIT_CREDIT',
      entries: [{ accountId: 'acc-1' }]
    });
    mockPrisma.ledgerEntry.findFirst.mockResolvedValue({
      amountMinorUnits: BigInt(50000)
    });
    mockPrisma.depositIntent.findMany.mockResolvedValue([COMPLETED]);

    const summary = await reconcileDeposits();

    expect(summary).toMatchObject({ intentsChecked: 1, anomalies: [] });
  });

  it('keeps STALE_DEPOSIT_HOURS as a sane 24h threshold', () => {
    expect(STALE_DEPOSIT_HOURS).toBe(24);
  });
});
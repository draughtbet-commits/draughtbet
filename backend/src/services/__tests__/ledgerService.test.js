import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  ledgerTransaction: {
    create: jest.fn(),
    findUnique: jest.fn()
  },
  ledgerEntry: {
    create: jest.fn(),
    aggregate: jest.fn()
  },
  ledgerAccount: {
    upsert: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const {
  postLedgerTransaction,
  postAdjustment,
  getAccountBalance,
  getUserLedgerProjections,
  ensureUserAccounts,
  ensureSystemAccount,
  UnbalancedPostingError,
  InvalidAmountError,
  InsufficientFundsError,
  SYSTEM_ACCOUNT_ID
} = await import('../ledgerService.js');

const tx = mockPrisma;

describe('ledgerService postLedgerTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  });

  const basePost = {
    type: 'ADJUSTMENT',
    idempotencyKey: 'open-1',
    entries: [
      { accountId: 'sys-clearing', amountMinorUnits: -5000n },
      { accountId: 'acct-avail', amountMinorUnits: 5000n }
    ]
  };

  it('creates the transaction and its balanced entries', async () => {
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'lt-1', type: 'ADJUSTMENT' });
    mockPrisma.ledgerEntry.create
      .mockResolvedValueOnce({ id: 'le-1', accountId: 'sys-clearing', amountMinorUnits: -5000n })
      .mockResolvedValueOnce({ id: 'le-2', accountId: 'acct-avail', amountMinorUnits: 5000n });

    const result = await postLedgerTransaction(tx, basePost);

    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ADJUSTMENT',
        idempotencyKey: 'open-1'
      })
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(2);
    expect(result.replayed).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  it('rejects an unbalanced posting', async () => {
    await expect(
      postLedgerTransaction(tx, {
        ...basePost,
        entries: [
          { accountId: 'a', amountMinorUnits: -5000n },
          { accountId: 'b', amountMinorUnits: 4000n }
        ]
      })
    ).rejects.toThrow(UnbalancedPostingError);
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects fewer than two entries', async () => {
    await expect(
      postLedgerTransaction(tx, {
        ...basePost,
        entries: [{ accountId: 'a', amountMinorUnits: 0n }]
      })
    ).rejects.toThrow(UnbalancedPostingError);
  });

  it('rejects zero amounts', async () => {
    await expect(
      postLedgerTransaction(tx, {
        ...basePost,
        entries: [
          { accountId: 'a', amountMinorUnits: -5000n },
          { accountId: 'b', amountMinorUnits: 0n },
          { accountId: 'c', amountMinorUnits: 5000n }
        ]
      })
    ).rejects.toThrow(InvalidAmountError);
  });

  it('returns the existing transaction verbatim on idempotent replay', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      id: 'lt-1',
      type: 'ADJUSTMENT',
      entries: [{ id: 'le-1' }]
    });

    const result = await postLedgerTransaction(tx, basePost);

    expect(result.replayed).toBe(true);
    expect(result.transaction.id).toBe('lt-1');
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'open-1' },
      include: { entries: true }
    });
  });

  it('recovers a racing duplicate via P2002 and returns the winner', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lt-win',
        type: 'ADJUSTMENT',
        entries: []
      });

    const result = await postLedgerTransaction(tx, basePost);

    expect(result.replayed).toBe(true);
    expect(result.transaction.id).toBe('lt-win');
  });

  it('re-throws non-unique errors', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockRejectedValue({ code: 'P2025' });

    await expect(postLedgerTransaction(tx, basePost)).rejects.toEqual({ code: 'P2025' });
  });

  it('rejects unknown entry types', async () => {
    await expect(
      postLedgerTransaction(tx, { ...basePost, type: 'NOT_A_TYPE' })
    ).rejects.toThrow('Unknown ledger entry type');
  });
});

describe('ledgerService accounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the three player accounts via an atomic compound-unique upsert', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      const [id, userId, type, currency] = values;
      return [{ id, userId, type, currency }];
    });

    const accounts = await ensureUserAccounts(tx, 'user-1', 'NGN');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(Object.keys(accounts).sort()).toEqual(
      ['PLAYER_AVAILABLE', 'PLAYER_LOCKED', 'PLAYER_WITHDRAWAL_PENDING'].sort()
    );
    // values = [generated id, userId, type, currency]
    expect(mockPrisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      expect.any(String),
      'user-1',
      'PLAYER_AVAILABLE',
      'NGN'
    ]);
    expect(accounts.PLAYER_AVAILABLE).toMatchObject({ userId: 'user-1', type: 'PLAYER_AVAILABLE' });
  });

  it('creates system accounts with the deterministic singleton id', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      const [id, type, currency] = values;
      return [{ id, userId: null, type, currency }];
    });

    const account = await ensureSystemAccount(tx, 'PLATFORM_REVENUE', 'NGN');

    expect(SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN')).toBe('system:PLATFORM_REVENUE:NGN');
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    // values = [deterministic id, type, currency]
    expect(mockPrisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      'system:PLATFORM_REVENUE:NGN',
      'PLATFORM_REVENUE',
      'NGN'
    ]);
    expect(account.id).toBe('system:PLATFORM_REVENUE:NGN');
  });

  it('rejects creating a player type as a system account', async () => {
    await expect(ensureSystemAccount(tx, 'PLAYER_AVAILABLE', 'NGN')).rejects.toThrow(
      'Cannot create PLAYER_AVAILABLE as a system account'
    );
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('ledgerService projections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns available/locked/pending as exact decimal strings', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      const [id, userId, type, currency] = values;
      return [{ id: `${type}:${userId}`, userId, type, currency }];
    });
    mockPrisma.ledgerEntry.aggregate.mockImplementation(async ({ where }) => ({
      _sum: { amountMinorUnits: where.accountId.includes('PLAYER_AVAILABLE') ? 10000n : where.accountId.includes('PLAYER_LOCKED') ? 5000n : 0n }
    }));

    const projections = await getUserLedgerProjections(tx, 'user-1');

    expect(projections).toEqual({ available: '10000', locked: '5000', pending: '0' });
  });
});

describe('ledgerService balance', () => {
  it('returns 0n for an account with no entries', async () => {
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: null } });
    expect(await getAccountBalance(tx, 'acct-empty')).toBe(0n);
  });
});

describe('ledgerService postAdjustment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ledgerAccount.findMany = jest.fn().mockResolvedValue([]);
    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      if (values.length === 4) {
        const [id, userId, type, currency] = values;
        return [{ id: `${type}-${userId}`, userId, type, currency }];
      }
      const [id, type, currency] = values;
      return [{ id, userId: null, type, currency }];
    });
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'lt-adj', type: 'ADJUSTMENT' });
    mockPrisma.ledgerEntry.create
      .mockResolvedValueOnce({ id: 'le-1' })
      .mockResolvedValueOnce({ id: 'le-2' });
  });

  const base = {
    userId: 'user-1',
    amountMinorUnits: 10000n,
    reference: 'adj-ref-1',
    reason: 'customer refund',
    actorId: 'admin-1'
  };

  it('credits the player via CUSTOMER_LIABILITY write-down', async () => {
    await postAdjustment(tx, { ...base, direction: 'CREDIT' });

    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ADJUSTMENT',
        idempotencyKey: 'adjustment:adj-ref-1',
        metadata: expect.objectContaining({
          userId: 'user-1',
          direction: 'CREDIT',
          actorId: 'admin-1',
          reference: 'adj-ref-1'
        })
      })
    });
    const entries = mockPrisma.ledgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(entries[0]).toEqual({
      transactionId: 'lt-adj',
      accountId: 'system:CUSTOMER_LIABILITY:NGN',
      amountMinorUnits: -10000n
    });
    expect(entries[1]).toEqual({
      transactionId: 'lt-adj',
      accountId: 'PLAYER_AVAILABLE-user-1',
      amountMinorUnits: 10000n
    });
    // A credit never consults the affordable balance.
    expect(mockPrisma.ledgerAccount.findMany).not.toHaveBeenCalled();
  });

  it('debits the player against CUSTOMER_LIABILITY when balance is sufficient', async () => {
    mockPrisma.ledgerAccount.findMany.mockResolvedValue([{ id: 'PLAYER_AVAILABLE-user-1' }]);
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 15000n } });

    await postAdjustment(tx, { ...base, direction: 'DEBIT' });

    const entries = mockPrisma.ledgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(entries[0]).toEqual({
      transactionId: 'lt-adj',
      accountId: 'PLAYER_AVAILABLE-user-1',
      amountMinorUnits: -10000n
    });
    expect(entries[1]).toEqual({
      transactionId: 'lt-adj',
      accountId: 'system:CUSTOMER_LIABILITY:NGN',
      amountMinorUnits: 10000n
    });
  });

  it('refuses a debit that would overdraw the spendable balance', async () => {
    mockPrisma.ledgerAccount.findMany.mockResolvedValue([{ id: 'PLAYER_AVAILABLE-user-1' }]);
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 5000n } });

    await expect(postAdjustment(tx, { ...base, direction: 'DEBIT' })).rejects.toThrow(
      InsufficientFundsError
    );
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown direction', async () => {
    await expect(
      postAdjustment(tx, { ...base, direction: 'MOVED' })
    ).rejects.toThrow(InvalidAmountError);
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('is idempotent per reference and reports the replay', async () => {
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      id: 'lt-existing',
      type: 'ADJUSTMENT',
      entries: [{ id: 'le-x' }]
    });

    const result = await postAdjustment(tx, { ...base, direction: 'CREDIT' });

    expect(result.replayed).toBe(true);
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });
});
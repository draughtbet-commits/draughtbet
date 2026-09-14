import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
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
  },
  wallet: {
    findMany: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const {
  postLedgerTransaction,
  getAccountBalance,
  getUserLedgerProjections,
  ensureUserAccounts,
  ensureSystemAccount,
  backfillWalletOpeningBalance,
  backfillAndReconcileAllWallets,
  UnbalancedPostingError,
  InvalidAmountError,
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

  it('creates the three player accounts via the compound unique upsert', async () => {
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ where, create }) => ({ id: `id:${create.type}` }));

    const accounts = await ensureUserAccounts(tx, 'user-1', 'NGN');

    expect(mockPrisma.ledgerAccount.upsert).toHaveBeenCalledTimes(3);
    expect(Object.keys(accounts).sort()).toEqual(
      ['PLAYER_AVAILABLE', 'PLAYER_LOCKED', 'PLAYER_WITHDRAWAL_PENDING'].sort()
    );
    expect(mockPrisma.ledgerAccount.upsert).toHaveBeenCalledWith({
      where: { userId_type_currency: { userId: 'user-1', type: 'PLAYER_AVAILABLE', currency: 'NGN' } },
      create: { userId: 'user-1', type: 'PLAYER_AVAILABLE', currency: 'NGN' },
      update: {}
    });
  });

  it('creates system accounts with the deterministic singleton id', async () => {
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ where, create }) => ({ id: create.id ?? create.userId ?? where.id }));

    const account = await ensureSystemAccount(tx, 'PLATFORM_REVENUE', 'NGN');

    expect(SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN')).toBe('system:PLATFORM_REVENUE:NGN');
    expect(mockPrisma.ledgerAccount.upsert).toHaveBeenCalledWith({
      where: { id: 'system:PLATFORM_REVENUE:NGN' },
      create: { id: 'system:PLATFORM_REVENUE:NGN', type: 'PLATFORM_REVENUE', currency: 'NGN', userId: null },
      update: {}
    });
    expect(account.id).toBe('system:PLATFORM_REVENUE:NGN');
  });

  it('rejects creating a player type as a system account', async () => {
    mockPrisma.ledgerAccount.upsert.mockReturnValue({});
    await expect(ensureSystemAccount(tx, 'PLAYER_AVAILABLE', 'NGN')).rejects.toThrow(
      'Cannot create PLAYER_AVAILABLE as a system account'
    );
  });
});

describe('ledgerService projections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns available/locked/pending as exact decimal strings', async () => {
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ create }) => ({
      id: `${create.type}:${create.userId}`
    }));
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

describe('ledgerService backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  });

  const wallet = {
    id: 'w-1',
    userId: 'user-1',
    balanceMinorUnits: '10000',
    currency: 'NGN'
  };

  it('posts the opening transaction clearing->available and returns posted', async () => {
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ create }) => ({
      id: create.id ?? `${create.type}:${create.userId}`
    }));
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'lt-open' });
    mockPrisma.ledgerEntry.create.mockResolvedValue({});

    const result = await backfillWalletOpeningBalance(wallet);

    expect(result.posted).toBe(true);
    expect(result.replayed).toBe(false);
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ADJUSTMENT',
        idempotencyKey: 'opening-balance:w-1'
      })
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: {
        transactionId: 'lt-open',
        accountId: 'system:SYSTEM_OPENING_CLEARING:NGN',
        amountMinorUnits: -10000n
      }
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: {
        transactionId: 'lt-open',
        accountId: 'PLAYER_AVAILABLE:user-1',
        amountMinorUnits: 10000n
      }
    });
  });

  it('skips zero-balance wallets without creating a transaction', async () => {
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ create }) => ({
      id: create.id ?? `${create.type}:${create.userId}`
    }));

    const result = await backfillWalletOpeningBalance({ ...wallet, balanceMinorUnits: '0' });

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('zero-balance');
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('rejects a negative wallet balance', async () => {
    await expect(backfillWalletOpeningBalance({ ...wallet, balanceMinorUnits: '-10' }))
      .rejects.toThrow(InvalidAmountError);
  });

  it('backfillAndReconcileAllWallets reports every wallet reconciled', async () => {
    mockPrisma.wallet.findMany.mockResolvedValue([wallet, { ...wallet, id: 'w-2', userId: 'user-2' }]);
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.ledgerAccount.upsert.mockImplementation(async ({ create }) => ({
      id: create.id ?? `${create.type}:${create.userId}`
    }));
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'lt-open' });
    mockPrisma.ledgerEntry.create.mockResolvedValue({});
    mockPrisma.ledgerEntry.aggregate.mockImplementation(async ({ where }) => ({
      _sum: { amountMinorUnits: where.accountId.includes('PLAYER_AVAILABLE') ? 10000n : 0n }
    }));

    const summary = await backfillAndReconcileAllWallets();

    expect(summary.total).toBe(2);
    expect(summary.mismatched).toBe(0);
    expect(summary.allReconciled).toBe(true);
  });
});
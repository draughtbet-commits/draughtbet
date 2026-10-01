import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  stakeReservation: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  match: {
    findMany: jest.fn(),
  },
  ledgerAccount: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  ledgerEntry: {
    aggregate: jest.fn(),
  },
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma,
}));

jest.unstable_mockModule('../ledgerService.js', () => ({
  ensureUserAccounts: jest.fn(async () => ({
    PLAYER_LOCKED: { id: 'acct-locked' },
    PLAYER_AVAILABLE: { id: 'acct-available' },
  })),
  postLedgerTransaction: jest.fn(async () => ({ id: 'tx-1' })),
}));

const {
  auditStakeLocks,
  reconcileStakeLocks,
  findStakeLockAuditCandidates,
} = await import('../lockReconciliation.js');
const { postLedgerTransaction } = await import('../ledgerService.js');

const USER = 'user-1';

const setReservations = (rows) =>
  mockPrisma.stakeReservation.findMany.mockResolvedValue(rows);
const setMatches = (rows) => mockPrisma.match.findMany.mockResolvedValue(rows);
const setLocked = (value) => {
  mockPrisma.ledgerAccount.findFirst.mockResolvedValue({ id: 'acct-locked' });
  mockPrisma.ledgerEntry.aggregate.mockResolvedValue({
    _sum: { amountMinorUnits: BigInt(value) },
  });
};

describe('auditStakeLocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setLocked(0);
    setReservations([]);
    setMatches([]);
  });

  it('reports balanced when the lock equals live reservations', async () => {
    setReservations([{ matchId: 'm1', amountMinorUnits: 1_000_000n }]);
    setMatches([{ id: 'm1', status: 'FUNDED' }]);
    setLocked(1_000_000);

    const audit = await auditStakeLocks(mockPrisma, USER);

    expect(audit.expectedMinorUnits).toBe(1_000_000n);
    expect(audit.actualMinorUnits).toBe(1_000_000n);
    expect(audit.strandedMinorUnits).toBe(0n);
    expect(audit.staleReservations).toHaveLength(0);
    expect(audit.balanced).toBe(true);
  });

  it('flags a lock with no live reservation as stranded', async () => {
    setReservations([]);
    setLocked(200_000);

    const audit = await auditStakeLocks(mockPrisma, USER);

    expect(audit.expectedMinorUnits).toBe(0n);
    expect(audit.strandedMinorUnits).toBe(200_000n);
    expect(audit.balanced).toBe(false);
  });

  it('counts only reservations on live matches toward the expected lock', async () => {
    setReservations([
      { matchId: 'live', amountMinorUnits: 1_000_000n },
      { matchId: 'dead', amountMinorUnits: 100_000n },
    ]);
    setMatches([
      { id: 'live', status: 'IN_PLAY' },
      { id: 'dead', status: 'CANCELLED' },
    ]);
    setLocked(1_000_000);

    const audit = await auditStakeLocks(mockPrisma, USER);

    expect(audit.expectedMinorUnits).toBe(1_000_000n);
    expect(audit.staleReservations).toEqual([
      { matchId: 'dead', amountMinorUnits: '100000', matchStatus: 'CANCELLED' },
    ]);
    // The money is balanced; only the row is stale, so nothing is stranded.
    expect(audit.strandedMinorUnits).toBe(0n);
    expect(audit.balanced).toBe(false);
  });

  it('flags a live reservation whose lock was never posted', async () => {
    setReservations([{ matchId: 'm1', amountMinorUnits: 1_000_000n }]);
    setMatches([{ id: 'm1', status: 'READY' }]);
    setLocked(0);

    const audit = await auditStakeLocks(mockPrisma, USER);

    expect(audit.strandedMinorUnits).toBe(-1_000_000n);
  });
});

describe('reconcileStakeLocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setLocked(0);
    setReservations([]);
    setMatches([]);
    mockPrisma.stakeReservation.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
  });

  it('is a no-op for a balanced player', async () => {
    setReservations([{ matchId: 'm1', amountMinorUnits: 500_000n }]);
    setMatches([{ id: 'm1', status: 'FUNDED' }]);
    setLocked(500_000);

    const result = await reconcileStakeLocks(mockPrisma, USER);

    expect(result.repairedMinorUnits).toBe(0n);
    expect(postLedgerTransaction).not.toHaveBeenCalled();
    expect(mockPrisma.stakeReservation.updateMany).not.toHaveBeenCalled();
  });

  it('returns a stranded lock to the player', async () => {
    setReservations([]);
    setLocked(200_000);

    const result = await reconcileStakeLocks(mockPrisma, USER);

    expect(result.repairedMinorUnits).toBe(200_000n);
    expect(postLedgerTransaction).toHaveBeenCalledTimes(1);
    const call = postLedgerTransaction.mock.calls[0][1];
    expect(call.type).toBe('STAKE_RELEASED');
    expect(call.entries).toEqual([
      { accountId: 'acct-locked', amountMinorUnits: -200_000n },
      { accountId: 'acct-available', amountMinorUnits: 200_000n },
    ]);
    // Entries must net to zero or the ledger rejects the transaction.
    const net = call.entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n);
    expect(net).toBe(0n);
  });

  it('keys the ledger post so a replay cannot pay the same orphan twice', async () => {
    setReservations([]);
    setLocked(200_000);
    await reconcileStakeLocks(mockPrisma, USER);

    const first = postLedgerTransaction.mock.calls[0][1].idempotencyKey;
    // After a successful repair the lock is balanced, so a rerun posts nothing.
    setLocked(0);
    postLedgerTransaction.mockClear();
    await reconcileStakeLocks(mockPrisma, USER);

    expect(postLedgerTransaction).not.toHaveBeenCalled();
    expect(first).toContain('200000');
  });

  it('closes stale RESERVED rows without moving money when the ledger balances', async () => {
    setReservations([{ matchId: 'dead', amountMinorUnits: 100_000n }]);
    setMatches([{ id: 'dead', status: 'CANCELLED' }]);
    setLocked(0);

    const result = await reconcileStakeLocks(mockPrisma, USER);

    expect(result.repairedMinorUnits).toBe(0n);
    expect(result.staleRowsClosed).toBe(1);
    expect(mockPrisma.stakeReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RESERVED',
          matchId: { in: ['dead'] },
        }),
        data: { status: 'RELEASED' },
      }),
    );
    expect(postLedgerTransaction).not.toHaveBeenCalled();
  });

  it('never posts a negative correction for an under-locked live reservation', async () => {
    setReservations([{ matchId: 'm1', amountMinorUnits: 1_000_000n }]);
    setMatches([{ id: 'm1', status: 'FUNDED' }]);
    setLocked(0);

    const result = await reconcileStakeLocks(mockPrisma, USER);

    expect(result.repairedMinorUnits).toBe(0n);
    expect(postLedgerTransaction).not.toHaveBeenCalled();
  });
});

describe('findStakeLockAuditCandidates', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes players with reserved rows and players holding a lock', async () => {
    mockPrisma.stakeReservation.findMany.mockResolvedValue([
      { userId: 'a' },
      { userId: 'b' },
    ]);
    mockPrisma.ledgerAccount.findMany.mockResolvedValue([
      { userId: 'a' },
      { userId: 'c' },
    ]);

    const ids = await findStakeLockAuditCandidates(mockPrisma);

    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });
});
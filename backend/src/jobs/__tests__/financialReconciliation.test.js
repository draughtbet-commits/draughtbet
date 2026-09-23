import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  financialReconciliationRun: { create: jest.fn(), update: jest.fn() },
  reconciliationIssue: { createMany: jest.fn(async ({ data }) => ({ count: data.length })) },
  ledgerEntry: { groupBy: jest.fn() },
  ledgerTransaction: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  ledgerAccount: { findMany: jest.fn(), count: jest.fn() },
  withdrawal: { findMany: jest.fn() },
  depositIntent: { findMany: jest.fn() },
  matchSettlement: { findMany: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { runFinancialReconciliation } = await import('../financialReconciliation.js');

const emptyPage = (fn) => fn.mockResolvedValue([]);

const healthyLedger = () => {
  // one balanced double-entry transaction
  mockPrisma.ledgerEntry.groupBy.mockImplementation(async ({ by }) => {
    if (by[0] === 'transactionId') {
      return [{ transactionId: 'tx-1', _sum: { amountMinorUnits: 0n }, _count: { _all: 2 } }];
    }
    // by accountId: liability -50000 / player available +50000 do NOT balance,
    // so the closed-book check needs accounts that close. Use a net-zero world:
    // single account per type with a 0 entry keeps floats at zero.
    return [];
  });
  mockPrisma.ledgerTransaction.count.mockResolvedValue(0);
  mockPrisma.ledgerAccount.findMany.mockResolvedValue([]);
  mockPrisma.ledgerAccount.count.mockResolvedValue(1);
  emptyPage(mockPrisma.withdrawal.findMany);
  emptyPage(mockPrisma.depositIntent.findMany);
  mockPrisma.matchSettlement.findMany.mockResolvedValue([]);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.financialReconciliationRun.create.mockResolvedValue({ id: 'run-1' });
  mockPrisma.financialReconciliationRun.update.mockResolvedValue({ id: 'run-1' });
  healthyLedger();
});

describe('runFinancialReconciliation', () => {
  it('passes a healthy double-entry ledger and records PASSED', async () => {
    const result = await runFinancialReconciliation({ clock: () => new Date('2026-01-01T00:00:00Z') });

    expect(result.status).toBe('PASSED');
    expect(result.discrepancies).toEqual([]);
    expect(mockPrisma.financialReconciliationRun.create).toHaveBeenCalledWith({ data: { status: 'RUNNING' } });
    expect(mockPrisma.financialReconciliationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({ status: 'PASSED', checkedAt: expect.any(Date) })
    });
  });

  it('fails when a transaction is unbalanced or undersized', async () => {
    mockPrisma.ledgerEntry.groupBy.mockImplementation(async ({ by }) => {
      if (by[0] === 'transactionId') {
        return [
          { transactionId: 'tx-1', _sum: { amountMinorUnits: 0n }, _count: { _all: 2 } },
          { transactionId: 'tx-2', _sum: { amountMinorUnits: 100n }, _count: { _all: 2 } },
          { transactionId: 'tx-3', _sum: { amountMinorUnits: 0n }, _count: { _all: 1 } }
        ];
      }
      return [];
    });
    mockPrisma.ledgerTransaction.count.mockResolvedValue(1);

    const result = await runFinancialReconciliation();

    expect(result.status).toBe('FAILED');
    expect(result.discrepancies.length).toBeGreaterThan(0);
    expect(result.discrepancies.join(' ')).toMatch(/ledger\.transactions_balanced/);
    // Typed rows land beside the JSON summary.
    expect(result.issues.length).toBeGreaterThan(0);
    expect(mockPrisma.reconciliationIssue.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ type: 'LEDGER_UNBALANCED', severity: 'HIGH', runId: 'run-1', entityType: 'LedgerTransaction' })]) })
    );
  });

  it('fails when player float + system accounts do not net to zero', async () => {
    mockPrisma.ledgerEntry.groupBy.mockImplementation(async ({ by }) => {
      if (by[0] === 'transactionId') return [];
      return [{ accountId: 'acc-light', _sum: { amountMinorUnits: 50000n } }];
    });
    mockPrisma.ledgerAccount.findMany.mockResolvedValue([
      { id: 'acc-light', type: 'PLAYER_AVAILABLE' }
    ]);

    const result = await runFinancialReconciliation();

    expect(result.status).toBe('FAILED');
    expect(result.discrepancies.join(' ')).toMatch(/ledger\.closed_book/);
  });

  it('flags a COMPLETED withdrawal that lacks its complete posting', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([{ id: 'wd-1', status: 'COMPLETED', amountMinorUnits: 100000n, userId: 'user-1' }]);
    mockPrisma.ledgerTransaction.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation();

    expect(result.discrepancies.join(' ')).toMatch(/withdrawal\.wd-1\.complete/);
    expect(result.status).toBe('FAILED');
  });

  it('flags a non-terminal withdrawal that already has a terminal posting', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([{ id: 'wd-1', status: 'PROCESSING', amountMinorUnits: 100000n, userId: 'user-1' }]);
    mockPrisma.ledgerTransaction.findMany.mockResolvedValue([
      {
        idempotencyKey: 'withdrawal:complete:wd-1',
        entries: [
          { amountMinorUnits: -100000n },
          { amountMinorUnits: 100000n }
        ]
      }
    ]);

    const result = await runFinancialReconciliation();

    expect(result.discrepancies.join(' ')).toMatch(/withdrawal\.wd-1\.no_terminal/);
  });

  it('flags a COMPLETED deposit whose credit posting is missing', async () => {
    mockPrisma.depositIntent.findMany.mockResolvedValue([
      { id: 'dep-1', status: 'COMPLETED', reference: 'ref-1', amountMinorUnits: 50000n }
    ]);
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);

    const result = await runFinancialReconciliation();

    expect(result.discrepancies.join(' ')).toMatch(/deposit\.dep-1\.credit/);
  });

  it('flags a PENDING deposit that already has a credit posting', async () => {
    mockPrisma.depositIntent.findMany.mockResolvedValue([
      { id: 'dep-1', status: 'PENDING', reference: 'ref-1', amountMinorUnits: 50000n }
    ]);
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
      idempotencyKey: 'deposit:credit:ref-1',
      entries: [
        { accountId: 'liab', amountMinorUnits: -50000n },
        { accountId: 'avail', amountMinorUnits: 50000n }
      ]
    });

    const result = await runFinancialReconciliation();

    expect(result.discrepancies.join(' ')).toMatch(/deposit\.dep-1\.credit\.exclusive/);
  });

  it('flags a settled match with no settlement posting', async () => {
    mockPrisma.matchSettlement.findMany.mockResolvedValue([
      { matchId: 'm1', netPayoutMinorUnits: 180000n }
    ]);
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);

    const result = await runFinancialReconciliation();

    expect(result.discrepancies.join(' ')).toMatch(/settlement\.m1\.posting/);
  });

  it('pages through withdrawal and deposit rows', async () => {
    // do-while loops only continue while a full PAGE_SIZE page came back
    const FULL_PAGE = Array.from({ length: 200 }, () => ({}));
    let withdrawalCalls = 0;
    mockPrisma.withdrawal.findMany.mockImplementation(async () => {
      withdrawalCalls++;
      return withdrawalCalls === 1 ? FULL_PAGE : [];
    });
    let depositCalls = 0;
    mockPrisma.depositIntent.findMany.mockImplementation(async () => {
      depositCalls++;
      return depositCalls === 1 ? FULL_PAGE : [];
    });

    const result = await runFinancialReconciliation();

    // Pagination is the point of this test: the do-while must keep reading past
    // full pages. Row content is irrelevant here (empty rows trip checks, so
    // the run's PASS/FAIL status is not asserted).
    expect(withdrawalCalls).toBe(2);
    expect(depositCalls).toBe(2);
    expect(result.runId).toBe('run-1');
  });
});
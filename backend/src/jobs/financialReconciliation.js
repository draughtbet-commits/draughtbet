import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { PLAYER_ACCOUNT_TYPES } from '../services/ledgerService.js';

// Financial reconciliation: an independent integrity sweep over the V2 ledger.
// It NEVER repairs — a discrepancy is recorded on a FinancialReconciliationRun
// (and logged) for operator attention. Every check is read-only and restart-
// safe: a half-finished run leaves a RUNNING row and the next pass starts fresh.

const PAGE_SIZE = 200;

const check = (results, name, ok, detail) => {
  results.checks.push({ name, ok, detail: ok ? null : detail });
  if (!ok) results.discrepancies.push(`${name}: ${detail}`);
};

export async function runFinancialReconciliation({ clock = () => new Date() } = {}) {
  const startedAt = clock();
  const run = await prisma.financialReconciliationRun.create({
    data: { status: 'RUNNING' }
  });

  const results = { discrepancies: [], checks: [] };

  // ── Core ledger integrity ─────────────────────────────────────────
  // Every transaction must be double-entry: >= 2 entries netting to zero.
  const balances = await prisma.ledgerEntry.groupBy({
    by: ['transactionId'],
    _sum: { amountMinorUnits: true },
    _count: { _all: true }
  });
  const unbalanced = balances.filter((b) => (b._sum.amountMinorUnits ?? 0n) !== 0n || b._count._all < 2);
  const emptyTx = await prisma.ledgerTransaction.count({ where: { entries: { none: {} } } });
  check(
    results,
    'ledger.transactions_balanced',
    unbalanced.length === 0 && emptyTx === 0,
    `${unbalanced.length} transaction(s) unbalanced/undersized, ${emptyTx} empty`
  );

  // ── Closed book: player float must net against system accounts ────
  const [accountSums, accounts] = await Promise.all([
    prisma.ledgerEntry.groupBy({ by: ['accountId'], _sum: { amountMinorUnits: true } }),
    prisma.ledgerAccount.findMany({ select: { id: true, type: true } })
  ]);
  const byAccount = new Map(accountSums.map((s) => [s.accountId, s._sum.amountMinorUnits ?? 0n]));
  let playerFloat = 0n;
  let systemFloat = 0n;
  for (const account of accounts) {
    const balance = byAccount.get(account.id) ?? 0n;
    if (PLAYER_ACCOUNT_TYPES.includes(account.type)) playerFloat += balance;
    else systemFloat += balance;
  }
  // Money is conserved across the player/system divide: every kobo held in a
  // player account must be offset by a liability/system account, so the two
  // sides cancel out. A healthy book with deposits in flight closes here.
  const netBook = playerFloat + systemFloat;
  check(
    results,
    'ledger.closed_book',
    netBook === 0n,
    `player float + system accounts must net to zero: playerFloat=${playerFloat}, systemFloat=${systemFloat}, net=${netBook}`
  );

  // ── Liability singleton ───────────────────────────────────────────
  const liability = await prisma.ledgerAccount.count({ where: { type: 'CUSTOMER_LIABILITY' } });
  check(results, 'ledger.liability_singleton', liability === 1, `found ${liability} CUSTOMER_LIABILITY accounts`);

  // ── Withdrawal postings per status ────────────────────────────────
  let withdrawalSkip = 0;
  let withdrawalRows;
  do {
    withdrawalRows = await prisma.withdrawal.findMany({
      orderBy: { createdAt: 'asc' },
      skip: withdrawalSkip,
      take: PAGE_SIZE,
      select: { id: true, status: true, amountMinorUnits: true, userId: true }
    });
    for (const w of withdrawalRows) {
      const keys = [
        `withdrawal:reserve:${w.id}`,
        `withdrawal:complete:${w.id}`,
        `withdrawal:release:${w.id}`
      ];
      const txs = await prisma.ledgerTransaction.findMany({
        where: { idempotencyKey: { in: keys } },
        include: { entries: true },
        orderBy: { createdAt: 'asc' }
      });
      const byKey = new Map(txs.map((t) => [t.idempotencyKey, t]));

      const reserve = byKey.get(`withdrawal:reserve:${w.id}`);
      check(
        results,
        `withdrawal.${w.id}.reserve`,
        Boolean(reserve),
        `missing withdrawal:reserve posting`
      );
      if (reserve) {
        const net = reserve.entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n);
        const sizeOk = reserve.entries.length >= 2 && net === 0n;
        const amountOk = reserve.entries.some((e) => e.amountMinorUnits === w.amountMinorUnits);
        check(results, `withdrawal.${w.id}.reserve.amount`, sizeOk && amountOk, `reserve posting does not cover the reserved amount`);
      }

      const complete = byKey.get(`withdrawal:complete:${w.id}`);
      const release = byKey.get(`withdrawal:release:${w.id}`);
      if (w.status === 'COMPLETED') {
        check(results, `withdrawal.${w.id}.complete`, Boolean(complete), `COMPLETED without withdrawal:complete posting`);
        check(results, `withdrawal.${w.id}.complete.exclusive`, !release, `COMPLETED also has a release posting`);
      } else if (w.status === 'RELEASED') {
        check(results, `withdrawal.${w.id}.release`, Boolean(release), `RELEASED without withdrawal:release posting`);
        check(results, `withdrawal.${w.id}.release.exclusive`, !complete, `RELEASED also has a complete posting`);
      } else {
        check(results, `withdrawal.${w.id}.no_terminal`, !complete && !release, `non-terminal withdrawal has a terminal posting`);
      }
    }
    withdrawalSkip += withdrawalRows.length;
  } while (withdrawalRows.length === PAGE_SIZE);

  // ── Deposit postings per status ───────────────────────────────────
  let depositCursor = 0;
  let deposits;
  do {
    deposits = await prisma.depositIntent.findMany({
      orderBy: { createdAt: 'asc' },
      skip: depositCursor,
      take: PAGE_SIZE,
      select: { id: true, status: true, reference: true, amountMinorUnits: true }
    });
    for (const d of deposits) {
      const credit = await prisma.ledgerTransaction.findUnique({
        where: { idempotencyKey: `deposit:credit:${d.reference}` },
        include: { entries: { select: { accountId: true, amountMinorUnits: true } } }
      });
      const overlap = d.status === 'PENDING' || d.status === 'FAILED';
      if (d.status === 'COMPLETED') {
        check(results, `deposit.${d.id}.credit`, Boolean(credit), `COMPLETED without deposit:credit posting`);
        if (credit) {
          const net = credit.entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n);
          const hasDebit = credit.entries.some((e) => e.amountMinorUnits === -d.amountMinorUnits);
          const hasCredit = credit.entries.some((e) => e.amountMinorUnits === d.amountMinorUnits);
          check(
            results,
            `deposit.${d.id}.credit.amount`,
            net === 0n && hasDebit && hasCredit,
            `deposit:credit posting does not match the intent amount`
          );
        }
      } else if (overlap && credit) {
        check(results, `deposit.${d.id}.credit.exclusive`, false, `${d.status} intent already has a deposit:credit posting`);
      }
    }
    depositCursor += deposits.length;
  } while (deposits.length === PAGE_SIZE);

  // ── Settlement postings ───────────────────────────────────────────
  const settlements = await prisma.matchSettlement.findMany({
    select: { matchId: true, netPayoutMinorUnits: true }
  });
  for (const s of settlements) {
    const posting = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `MATCH_SETTLEMENT:${s.matchId}` },
      include: { entries: { select: { amountMinorUnits: true } } }
    });
    check(results, `settlement.${s.matchId}.posting`, Boolean(posting), `settled match without MATCH_SETTLEMENT posting`);
    if (posting) {
      const net = posting.entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n);
      const coversPayout = posting.entries.some((e) => e.amountMinorUnits === s.netPayoutMinorUnits);
      check(results, `settlement.${s.matchId}.posting.amount`, net === 0n && coversPayout, `settlement posting does not cover the recorded payout`);
    }
  }

  const status = results.discrepancies.length === 0 ? 'PASSED' : 'FAILED';
  await prisma.financialReconciliationRun.update({
    where: { id: run.id },
    data: {
      status,
      discrepancies: results.discrepancies,
      checkedAt: clock()
    }
  });

  if (results.discrepancies.length > 0) {
    logger.error({ runId: run.id, count: results.discrepancies.length }, 'Financial reconciliation flagged discrepancies');
  } else {
    logger.info({ runId: run.id }, 'Financial reconciliation passed');
  }
  return { runId: run.id, status, discrepancies: results.discrepancies, checks: results.checks };
}

let isSweeping = false;

export const startFinancialReconciliation = () => {
  // Every 5 minutes.
  return cron.schedule('*/5 * * * *', async () => {
    if (isSweeping) return;
    isSweeping = true;
    try {
      await runFinancialReconciliation();
    } catch (err) {
      logger.error({ err }, 'Financial reconciliation sweep failed');
    } finally {
      isSweeping = false;
    }
  });
};
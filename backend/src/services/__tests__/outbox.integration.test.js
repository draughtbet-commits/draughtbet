// Real-PostgreSQL integration test for the outbox pipeline (lease claims,
// crash recovery, dedupe). Runs against a scratch Postgres with migrations:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/services/__tests__/outbox.integration.test.js
import crypto from 'crypto';
import prisma from '../../utils/db.js';
import { enqueueEvent } from '../outboxService.js';
import { processOutboxDrainer } from '../../jobs/outboxDrainer.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Outbox pipeline (real PostgreSQL)', () => {
  const keys = [];
  const trackKey = (k) => keys.push(k);

  const cleanup = async () => {
    await prisma.outboxEvent.deleteMany({
      where: { dedupeKey: { in: keys } }
    });
    keys.length = 0;
  };

  afterEach(cleanup);

  // The drainer sweeps the WHOLE table, so the suites must start from an empty
  // queue: earlier suites in the shared battery DB may have left PENDING rows
  // (settlement/withdrawal events) that would otherwise pollute the global
  // scanned/claimed/delivered counts asserted below.
  beforeAll(async () => {
    await prisma.outboxEvent.deleteMany({});
  });

  const enqueue = (dedupeKey, overrides = {}) =>
    prisma.$transaction((tx) =>
      enqueueEvent(tx, {
        aggregateType: 'Wallet',
        aggregateId: `wallet-${dedupeKey}`,
        eventType: 'wallet.updated',
        dedupeKey,
        payload: { userId: `user-${dedupeKey}`, walletId: `wallet-${dedupeKey}`, balanceChange: '100000' },
        ...overrides
      })
    );

  it('drains a PENDING event to SENT exactly once', async () => {
    const key = `it-drain-${crypto.randomUUID()}`;
    trackKey(key);
    await enqueue(key);

    const delivered = [];
    const result = await processOutboxDrainer({
      clock: () => new Date(),
      deliver: async (event) => {
        delivered.push(event.id);
      }
    });

    expect(result).toMatchObject({ scanned: 1, claimed: 1, delivered: 1, failed: 0 });
    expect(delivered).toHaveLength(1);

    const [row] = await prisma.outboxEvent.findMany({ where: { dedupeKey: key } });
    expect(row.status).toBe('SENT');
    expect(row.claimToken).toBeNull();
    expect(row.claimExpiresAt).toBeNull();
  });

  it('reclaims and redelivers a row a crashed worker left claimed with an expired lease', async () => {
    const key = `it-crash-${crypto.randomUUID()}`;
    trackKey(key);
    const { id } = await enqueue(key);

    // crashed worker claimed it but never settled the SENT
    await prisma.outboxEvent.updateMany({
      where: { id },
      data: { claimToken: 'crashed-worker', claimExpiresAt: new Date(Date.now() - 60_000) }
    });

    const delivered = [];
    const result = await processOutboxDrainer({
      clock: () => new Date(),
      deliver: async (event) => {
        delivered.push(event.id);
      }
    });

    expect(delivered).toEqual([id]);
    expect(result.delivered).toBe(1);
    const [row] = await prisma.outboxEvent.findMany({ where: { dedupeKey: key } });
    expect(row.status).toBe('SENT');
    expect(row.claimToken).toBeNull();
  });

  it('leaves an in-flight row (live lease) alone for its claimer to finish', async () => {
    const key = `it-inflight-${crypto.randomUUID()}`;
    trackKey(key);
    const { id } = await enqueue(key);

    await prisma.outboxEvent.updateMany({
      where: { id },
      data: { claimToken: 'live-worker', claimExpiresAt: new Date(Date.now() + 30_000) }
    });

    const delivered = [];
    const result = await processOutboxDrainer({
      clock: () => new Date(),
      deliver: async (event) => {
        delivered.push(event.id);
      }
    });

    expect(delivered).toHaveLength(0);
    expect(result).toMatchObject({ claimed: 0, delivered: 0 });
    const [row] = await prisma.outboxEvent.findMany({ where: { dedupeKey: key } });
    expect(row.status).toBe('PENDING');
  });

  it('parks an event FAILED once delivery exceeds the max attempts', async () => {
    const key = `it-fail-${crypto.randomUUID()}`;
    trackKey(key);
    await enqueue(key);

    const result = await processOutboxDrainer({
      clock: () => new Date(),
      maxAttempts: 2,
      deliver: async () => {
        throw new Error('socket unreachable');
      }
    });

    // first attempt fails and backs off (attempts=1), so needs a second cycle
    expect(result).toMatchObject({ claimed: 1, delivered: 0, backoff: 1, failed: 0 });

    const second = await processOutboxDrainer({
      clock: () => new Date(),
      maxAttempts: 2,
      deliver: async () => {
        throw new Error('still unreachable');
      }
    });
    expect(second).toMatchObject({ claimed: 1, delivered: 0, backoff: 0, failed: 1 });

    const [row] = await prisma.outboxEvent.findMany({ where: { dedupeKey: key } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
    expect(row.claimToken).toBeNull();
  });

  it('enqueueing the same dedupeKey twice is a no-op (only one row)', async () => {
    const key = `it-dedupe-${crypto.randomUUID()}`;
    trackKey(key);

    await enqueue(key);
    const second = await enqueue(key);

    expect(second).toBeNull();
    const rows = await prisma.outboxEvent.findMany({ where: { dedupeKey: key } });
    expect(rows).toHaveLength(1);
  });
});
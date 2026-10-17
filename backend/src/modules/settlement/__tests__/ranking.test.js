import { jest } from '@jest/globals';
import { applyMatchOutcome, reverseMatchRatings } from '../playerStatsService.js';
import {
  DEFAULT_RATING_CONFIG,
  resolveRatingConfig,
  rankForRating,
  expectedScore,
  kFactorFor,
  isProvisional,
  nextRating,
  reasonForEndReason
} from '../rating.js';

const SETTINGS = {
  startingRating: 1200,
  provisionalMatchCount: 20,
  provisionalKFactor: 40,
  establishedKFactor: 24,
  masterRankMinRating: 1400,
  proRankMinRating: 1800
};

// Minimal in-memory transaction stand-in that mimics the prisma calls the
// rating service makes (findUnique/upsert/createMany/user.update), including
// `{ increment }` semantics and a per-tx RatingEvent store.
function makeTx({ settings = SETTINGS, stats = {}, events = [] } = {}) {
  const store = { ...stats };
  const tx = {
    _store: store,
    _events: [...events],
    platformSettings: { findUnique: jest.fn(async () => settings) },
    playerStats: {
      findUnique: jest.fn(async ({ where }) => store[where.userId] ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const existing = store[where.userId];
        if (existing) {
          const next = { ...existing };
          for (const [k, v] of Object.entries(update ?? {})) {
            next[k] = v && typeof v === 'object' && 'increment' in v ? (existing[k] ?? 0) + v.increment : v;
          }
          store[where.userId] = next;
          return next;
        }
        store[where.userId] = { id: `ps-${where.userId}`, ...create };
        return store[where.userId];
      })
    },
    user: { update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })) },
    ratingEvent: {
      createMany: jest.fn(async ({ data }) => {
        tx._events.push(...data);
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }) =>
        tx._events.filter((e) => (where.matchId ? e.matchId === where.matchId : true))
      )
    }
  };
  return tx;
}

describe('rating — pure maths', () => {
  it('starts new players at the configured rating and ranks them AMATEUR', () => {
    expect(DEFAULT_RATING_CONFIG.startingRating).toBe(1200);
    expect(rankForRating(1200, SETTINGS)).toBe('AMATEUR');
  });

  it('draws the configured rank bands exactly (no off-by-one)', () => {
    expect(rankForRating(1399, SETTINGS)).toBe('AMATEUR');
    expect(rankForRating(1400, SETTINGS)).toBe('MASTER');
    expect(rankForRating(1799, SETTINGS)).toBe('MASTER');
    expect(rankForRating(1800, SETTINGS)).toBe('PRO');
    expect(rankForRating(99999, SETTINGS)).toBe('PRO');
  });

  it('uses the provisional K before the threshold and the established K after', () => {
    expect(kFactorFor(0, SETTINGS)).toBe(40);
    expect(kFactorFor(19, SETTINGS)).toBe(40);
    expect(kFactorFor(20, SETTINGS)).toBe(24);
    expect(isProvisional(0, SETTINGS)).toBe(true);
    expect(isProvisional(19, SETTINGS)).toBe(true);
    expect(isProvisional(20, SETTINGS)).toBe(false);
  });

  it('equal ratings give 0.5 expected score; a win at provisional K is +20', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 10);
    expect(nextRating({ rating: 1200, opponentRating: 1200, score: 1, matchesPlayed: 0, config: SETTINGS })).toBe(1220);
    expect(nextRating({ rating: 1200, opponentRating: 1200, score: 0, matchesPlayed: 0, config: SETTINGS })).toBe(1180);
  });

  it('resolves config with per-field fallbacks', () => {
    expect(resolveRatingConfig({ startingRating: 1000 })).toMatchObject({ startingRating: 1000, provisionalKFactor: 40 });
    expect(resolveRatingConfig({})).toEqual({ ...SETTINGS });
  });

  it('maps end reasons to the spec reasons', () => {
    expect(reasonForEndReason('timeout')).toBe('TIMEOUT');
    expect(reasonForEndReason('resign')).toBe('RESIGNATION');
    expect(reasonForEndReason('forfeit_disconnect')).toBe('DISCONNECT');
    expect(reasonForEndReason('NO_LEGAL_MOVES')).toBe('NORMAL');
    expect(reasonForEndReason(null)).toBe('NORMAL');
  });
});

describe('applyMatchOutcome — rated', () => {
  it('moves the winner up and the loser down and writes one event each', async () => {
    const tx = makeTx();
    const { ratings } = await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: 'p1' });

    expect(tx.ratingEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    const [win, loss] = ratings;
    expect(win).toMatchObject({ userId: 'p1', result: 'WIN', previousRating: 1200, newRating: 1220, ratingDelta: 20, rated: true });
    expect(loss).toMatchObject({ userId: 'p2', result: 'LOSS', previousRating: 1200, newRating: 1180, ratingDelta: -20, rated: true });
    expect(tx.playerStats.upsert).toHaveBeenCalledTimes(2);
    // No band crossing → no tier rewrite.
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('records the configured reason on the event', async () => {
    const tx = makeTx();
    await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: 'p1', endReason: 'timeout' });
    const [event] = tx.ratingEvent.createMany.mock.calls[0][0].data;
    expect(event.reason).toBe('TIMEOUT');
  });

  it('promotes across the master band and rewrites User.tier', async () => {
    const tx = makeTx({ stats: { p1: { rating: 1390, totalMatches: 30 }, p2: { rating: 1390, totalMatches: 30 } } });
    const { ratings, promotions } = await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: 'p1' });

    const win = ratings.find((r) => r.userId === 'p1');
    // Established K=24, equal ratings → +12 → 1402 → MASTER.
    expect(win).toMatchObject({ previousRating: 1390, newRating: 1402, previousRank: 'AMATEUR', newRank: 'MASTER', isRankUp: true });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { tier: 'MASTER' } });
    expect(tx.user.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p2' } }));
    expect(promotions).toEqual([
      expect.objectContaining({ userId: 'p1', fromRank: 'AMATEUR', toRank: 'MASTER', isRankUp: true })
    ]);
  });

  it('demotes across the master band on a loss (spec test #7)', async () => {
    const tx = makeTx({ stats: { p1: { rating: 1405, totalMatches: 30 }, p2: { rating: 1405, totalMatches: 30 } } });
    const { ratings } = await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: 'p1' });

    const loss = ratings.find((r) => r.userId === 'p2');
    // 1405 - 12 = 1393 → back to AMATEUR.
    expect(loss).toMatchObject({ previousRank: 'MASTER', newRank: 'AMATEUR', isRankDown: true, isRankUp: false });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'p2' }, data: { tier: 'AMATEUR' } });
  });

  it('is driven entirely by configuration (custom bands/K)', async () => {
    const tx = makeTx({
      settings: { ...SETTINGS, masterRankMinRating: 1000, establishedKFactor: 10 },
      stats: { p1: { rating: 995, totalMatches: 50 }, p2: { rating: 995, totalMatches: 50 } }
    });
    const { ratings } = await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: 'p1' });
    const win = ratings.find((r) => r.userId === 'p1');
    // K=10, expected 0.5 → +5 → 1000 = MASTER under the custom floor.
    expect(win.newRating).toBe(1000);
    expect(win.newRank).toBe('MASTER');
  });

  it('a draw between equal ratings is a zero delta', async () => {
    const tx = makeTx();
    const { ratings } = await applyMatchOutcome(tx, { matchId: 'm1', players: ['p1', 'p2'], winnerId: null });
    expect(ratings.map((r) => r.result)).toEqual(['DRAW', 'DRAW']);
    expect(ratings.every((r) => r.ratingDelta === 0)).toBe(true);
  });
});

describe('applyMatchOutcome — unrated', () => {
  it('never moves rating, stats or tier, but records an audit event (spec test #9)', async () => {
    const tx = makeTx({ stats: { p1: { rating: 1500, totalMatches: 5 }, p2: { rating: 1300, totalMatches: 5 } } });
    const { ratings, promotions } = await applyMatchOutcome(tx, {
      matchId: 'm1',
      players: ['p1', 'p2'],
      winnerId: 'p1',
      rated: false
    });

    expect(tx.playerStats.upsert).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(ratings.every((r) => r.rated === false && r.ratingDelta === 0)).toBe(true);
    expect(ratings.find((r) => r.userId === 'p1')).toMatchObject({ previousRating: 1500, newRating: 1500, result: 'WIN' });
    expect(promotions).toEqual([]);
    // Audit row still written, flagged unrated.
    const events = tx.ratingEvent.createMany.mock.calls[0][0].data;
    expect(events.every((e) => e.rated === false && e.delta === 0)).toBe(true);
  });
});

describe('reverseMatchRatings — admin reversal', () => {
  const normalEvents = [
    { id: 're-1', userId: 'p1', matchId: 'm1', ratingBefore: 1200, ratingAfter: 1220, delta: 20, rated: true, result: 'WIN', previousRank: 'AMATEUR', newRank: 'AMATEUR', createdAt: 1 },
    { id: 're-2', userId: 'p2', matchId: 'm1', ratingBefore: 1200, ratingAfter: 1180, delta: -20, rated: true, result: 'LOSS', previousRank: 'AMATEUR', newRank: 'AMATEUR', createdAt: 1 }
  ];

  it('appends a REVERSAL event and negates the original delta without touching the original', async () => {
    const tx = makeTx({
      stats: { p1: { rating: 1220, totalMatches: 1 }, p2: { rating: 1180, totalMatches: 1 } },
      events: normalEvents
    });
    const summaries = await reverseMatchRatings(tx, { matchId: 'm1', players: ['p1', 'p2'] });

    expect(summaries).toHaveLength(2);
    const p1 = summaries.find((s) => s.userId === 'p1');
    expect(p1).toMatchObject({ result: 'REVERSAL', previousRating: 1220, newRating: 1200, ratingDelta: -20 });
    // Original rows are never updated/deleted — only createMany is used.
    expect(tx.ratingEvent.findMany).toHaveBeenCalled();
    expect(tx.ratingEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    const written = tx.ratingEvent.createMany.mock.calls[0][0].data;
    expect(written.every((e) => e.result === 'REVERSAL' && e.reason === 'ADMIN_REVERSAL')).toBe(true);
    // Original events in the store are unchanged.
    expect(tx._events.find((e) => e.id === 're-1').delta).toBe(20);
  });

  it('returns null when the match has no rated events', async () => {
    const tx = makeTx({ events: [] });
    expect(await reverseMatchRatings(tx, { matchId: 'm1', players: ['p1', 'p2'] })).toBeNull();
    expect(tx.ratingEvent.createMany).not.toHaveBeenCalled();
  });

  it('returns null defensively when there are no players', async () => {
    const tx = makeTx();
    expect(await reverseMatchRatings(tx, { matchId: 'm1', players: [] })).toBeNull();
  });
});

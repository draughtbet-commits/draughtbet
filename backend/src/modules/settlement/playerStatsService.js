import {
  DEFAULT_RATING_CONFIG,
  resolveRatingConfig,
  rankForRating,
  nextRating,
  isProvisional,
  reasonForEndReason
} from './rating.js';

const TIER_RANK = { AMATEUR: 0, MASTER: 1, PRO: 2 };

const within = (tx, userId) => {
  if (!userId) return null;
  return tx.playerStats.findUnique({ where: { userId } });
};

const readRatingConfig = async (tx) => {
  try {
    const settings = await tx.platformSettings.findUnique({ where: { id: 'singleton' } });
    return resolveRatingConfig(settings);
  } catch (_) {
    // Config lag (pre-migration DB / mock): fall back to the engineering
    // defaults rather than failing the settlement.
    return resolveRatingConfig(DEFAULT_RATING_CONFIG);
  }
};

const outcomeOf = (winnerId, userId) => {
  if (winnerId === null) return 'DRAW';
  return winnerId === userId ? 'WIN' : 'LOSS';
};

const scoreOf = (outcome) => (outcome === 'WIN' ? 1 : outcome === 'DRAW' ? 0.5 : 0);

/**
 * Applies a settled match outcome to both players inside the caller's
 * settlement transaction. Writes:
 *   - PlayerStats (rating + W/L/D + streak) for rated matches only
 *   - User.tier from the configured rating bands (rated matches only)
 *   - one immutable RatingEvent per player (rated or not — unrated matches get
 *     a zero-delta audit row with rated=false)
 *
 * Idempotent by construction: this only runs on the single settlement claim,
 * and the (userId, matchId, result) uniqueness is a second line of defence
 * against a duplicated result event.
 *
 * Returns the server-authoritative rating summaries and any rank changes so the
 * caller can surface them (API response) and enqueue promotions.
 */
export async function applyMatchOutcome(
  tx,
  { matchId, players, winnerId, rated = true, endReason = null }
) {
  const [lightId, darkId] = players;
  const config = await readRatingConfig(tx);
  const reason = reasonForEndReason(endReason);

  const [lightStats, darkStats] = await Promise.all([
    within(tx, lightId),
    within(tx, darkId)
  ]);

  const ratingOf = (stats) => stats?.rating ?? config.startingRating;
  const playedOf = (stats) => stats?.totalMatches ?? 0;

  const pre = {
    [lightId]: { rating: ratingOf(lightStats), matchesPlayed: playedOf(lightStats) },
    [darkId]: { rating: ratingOf(darkStats), matchesPlayed: playedOf(darkStats) }
  };

  const summaries = players.map((userId) => {
    const opponentId = userId === lightId ? darkId : lightId;
    const outcome = outcomeOf(winnerId, userId);
    const before = pre[userId];
    const opponent = pre[opponentId];

    if (!rated) {
      // Unrated: rating and rank are untouched; record the audit row only.
      const rank = rankForRating(before.rating, config);
      return {
        event: {
          userId,
          matchId,
          ratingBefore: before.rating,
          ratingAfter: before.rating,
          delta: 0,
          previousRank: rank,
          newRank: rank,
          result: outcome,
          reason: 'NORMAL',
          rated: false
        },
        summary: {
          userId,
          result: outcome,
          previousRating: before.rating,
          newRating: before.rating,
          ratingDelta: 0,
          previousRank: rank,
          newRank: rank,
          isRankUp: false,
          isRankDown: false,
          isProvisional: false,
          rated: false
        }
      };
    }

    const newRating = nextRating({
      rating: before.rating,
      opponentRating: opponent.rating,
      score: scoreOf(outcome),
      matchesPlayed: before.matchesPlayed,
      config
    });
    const previousRank = rankForRating(before.rating, config);
    const newRank = rankForRating(newRating, config);
    return {
      event: {
        userId,
        matchId,
        ratingBefore: before.rating,
        ratingAfter: newRating,
        delta: newRating - before.rating,
        previousRank,
        newRank,
        result: outcome,
        reason,
        rated: true
      },
      summary: {
        userId,
        result: outcome,
        previousRating: before.rating,
        newRating,
        ratingDelta: newRating - before.rating,
        previousRank,
        newRank,
        isRankUp: TIER_RANK[newRank] > TIER_RANK[previousRank],
        isRankDown: TIER_RANK[newRank] < TIER_RANK[previousRank],
        isProvisional: isProvisional(before.matchesPlayed + 1, config),
        rated: true
      }
    };
  });

  if (rated) {
    for (const { event } of summaries) {
      await upsertStat(tx, event.userId, event.result, event.ratingAfter);
      const currentTier = rankForRating(event.ratingBefore, config);
      if (currentTier !== event.newRank) {
        await tx.user.update({
          where: { id: event.userId },
          data: { tier: event.newRank }
        });
      }
    }
  }

  await tx.ratingEvent.createMany({
    data: summaries.map(({ event }) => event),
    skipDuplicates: true
  });

  const promotions = summaries
    .filter(({ summary }) => summary.rated && (summary.isRankUp || summary.isRankDown))
    .map(({ summary }) => ({
      userId: summary.userId,
      fromRank: summary.previousRank,
      toRank: summary.newRank,
      isRankUp: summary.isRankUp,
      newRating: summary.newRating
    }));

  return {
    ratings: summaries.map(({ summary }) => summary),
    promotions
  };
}

function upsertStat(tx, userId, outcome, ratingAfter) {
  return tx.playerStats.upsert({
    where: { userId },
    create: {
      userId,
      rating: ratingAfter,
      totalMatches: 1,
      ...(outcome === 'WIN'
        ? { wins: 1, currentStreak: 1 }
        : outcome === 'LOSS'
          ? { losses: 1, currentStreak: 0 }
          : { draws: 1 })
    },
    update: {
      rating: ratingAfter,
      totalMatches: { increment: 1 },
      ...(outcome === 'WIN'
        ? { wins: { increment: 1 }, currentStreak: { increment: 1 } }
        : outcome === 'LOSS'
          ? { losses: { increment: 1 }, currentStreak: 0 }
          : { draws: { increment: 1 } })
    }
  });
}

/**
 * Appends a single compensating REVERSAL rating event per player for a reversed
 * match result (dispute resolution). The original events are never edited or
 * deleted; each player's live rating is moved back by the delta the original
 * normal event applied, and the rank re-derived. Idempotent via the
 * (userId, matchId, result) unique index — a repeated reversal is a no-op.
 *
 * Returns the compensating summaries, or null when the match had no rated
 * events to reverse (e.g. an unrated or never-settled match).
 */
export async function reverseMatchRatings(tx, { matchId, players }) {
  // Defensive: schema lag (pre-migration client) or a match without both
  // participants has nothing to reverse.
  if (!players?.length || !tx.ratingEvent?.findMany) return null;
  const config = await readRatingConfig(tx);
  const original = await tx.ratingEvent.findMany({
    where: { matchId, userId: { in: players }, result: { not: 'REVERSAL' } }
  });
  const rated = original.filter((e) => e.rated);
  if (rated.length === 0) return null;

  const summaries = [];
  for (const event of rated) {
    const stats = await within(tx, event.userId);
    const currentRating = stats?.rating ?? event.ratingAfter;
    // Undo the original event's effect on the live rating.
    const newRating = currentRating - event.delta;
    const previousRank = rankForRating(currentRating, config);
    const newRank = rankForRating(newRating, config);

    await tx.playerStats.upsert({
      where: { userId: event.userId },
      create: { userId: event.userId, rating: newRating },
      update: { rating: newRating }
    });
    if (previousRank !== newRank) {
      await tx.user.update({ where: { id: event.userId }, data: { tier: newRank } });
    }
    await tx.ratingEvent.createMany({
      data: [
        {
          userId: event.userId,
          matchId,
          ratingBefore: currentRating,
          ratingAfter: newRating,
          delta: newRating - currentRating,
          previousRank,
          newRank,
          result: 'REVERSAL',
          reason: 'ADMIN_REVERSAL',
          rated: true
        }
      ],
      skipDuplicates: true
    });
    summaries.push({
      userId: event.userId,
      result: 'REVERSAL',
      previousRating: currentRating,
      newRating,
      ratingDelta: newRating - currentRating,
      previousRank,
      newRank,
      isRankUp: TIER_RANK[newRank] > TIER_RANK[previousRank],
      isRankDown: TIER_RANK[newRank] < TIER_RANK[previousRank],
      isProvisional: false,
      rated: true
    });
  }
  return summaries;
}

export default applyMatchOutcome;

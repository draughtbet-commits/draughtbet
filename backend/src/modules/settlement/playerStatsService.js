const K_FACTOR = 32;
const DEFAULT_RATING = 1200;

const expectedScore = (rating, opponentRating) => 1 / (1 + 10 ** ((opponentRating - rating) / 400));

const nextRating = (rating, opponentRating, score) => Math.round(rating + K_FACTOR * (score - expectedScore(rating, opponentRating)));

const within = (tx, userId) => {
  if (!userId) return null;
  return tx.playerStats.findUnique({ where: { userId } });
};

/**
 * Applies a settled match outcome to both players' PlayerStats and records the
 * RatingEvent history rows, inside the caller's settlement transaction.
 *
 * Rating is a simple K=32 Elo (1200 start, draw = 0.5). The stats upsert and
 * event create share the match's unique (userId, matchId) key so a replay can
 * never double-count; the rating is computed from the pre-match snapshot.
 */
export async function applyMatchOutcome(tx, { matchId, players, winnerId }) {
  const [lightId, darkId] = players;
  const [lightStats, darkStats] = await Promise.all([
    within(tx, lightId),
    within(tx, darkId)
  ]);

  const rating = (stats) => stats?.rating ?? DEFAULT_RATING;
  const rLight = rating(lightStats);
  const rDark = rating(darkStats);

  const outcomeFor = (userId) => {
    if (winnerId === null) return 'DRAW';
    return winnerId === userId ? 'WIN' : 'LOSS';
  };

  const outcomes = players.map((userId) => {
    const outcome = outcomeFor(userId);
    const score = outcome === 'WIN' ? 1 : outcome === 'DRAW' ? 0.5 : 0;
    const before = userId === lightId ? rLight : rDark;
    const opponent = userId === lightId ? rDark : rLight;
    return {
      userId,
      outcome,
      ratingBefore: before,
      ratingAfter: nextRating(before, opponent, score)
    };
  });

  const upsertStat = (userId, outcome, ratingAfter) =>
    tx.playerStats.upsert({
      where: { userId },
      create: {
        userId,
        rating: ratingAfter,
        totalMatches: 1,
        ...(outcome === 'WIN' ? { wins: 1, currentStreak: 1 } : outcome === 'LOSS' ? { losses: 1, currentStreak: 0 } : { draws: 1 })
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

  for (const { userId, outcome, ratingBefore, ratingAfter } of outcomes) {
    await upsertStat(userId, outcome, ratingAfter);
  }

  await tx.ratingEvent.createMany({
    data: outcomes.map(({ userId, ratingBefore, ratingAfter }) => ({
      userId,
      matchId,
      ratingBefore,
      ratingAfter,
      delta: ratingAfter - ratingBefore
    })),
    skipDuplicates: true
  });
}

export default applyMatchOutcome;
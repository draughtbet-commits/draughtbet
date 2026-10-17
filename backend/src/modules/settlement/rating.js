/**
 * Pure Elo-style rating maths and rank banding. No I/O: the settlement path
 * feeds these functions the live configuration so every number stays
 * admin-tunable (see `PlatformSettings` rating scalars) instead of hardcoded
 * inside the match service.
 *
 * Ranks are the agreed three-tier ladder (AMATEUR / MASTER / PRO) expressed as
 * per-rank rating floors. No additional rank may be introduced without product
 * approval.
 */

export const TIER_ORDER = Object.freeze(['AMATEUR', 'MASTER', 'PRO']);

// Engineering defaults. These mirror the PlatformSettings column defaults and
// are only used when a settings row is missing or a field is null (e.g. a
// pre-migration database), so the service never hard-fails on config lag.
export const DEFAULT_RATING_CONFIG = Object.freeze({
  startingRating: 1200,
  provisionalMatchCount: 20,
  provisionalKFactor: 40,
  establishedKFactor: 24,
  masterRankMinRating: 1400,
  proRankMinRating: 1800
});

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const nonNegativeInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/**
 * Projects the live settings row (or a partial/absent one) onto a complete,
 * validated rating config. Every field falls back independently.
 */
export function resolveRatingConfig(settings = {}) {
  const s = settings ?? {};
  return {
    startingRating: nonNegativeInt(s.startingRating, DEFAULT_RATING_CONFIG.startingRating),
    provisionalMatchCount: nonNegativeInt(
      s.provisionalMatchCount,
      DEFAULT_RATING_CONFIG.provisionalMatchCount
    ),
    provisionalKFactor: positiveInt(
      s.provisionalKFactor,
      DEFAULT_RATING_CONFIG.provisionalKFactor
    ),
    establishedKFactor: positiveInt(
      s.establishedKFactor,
      DEFAULT_RATING_CONFIG.establishedKFactor
    ),
    masterRankMinRating: nonNegativeInt(
      s.masterRankMinRating,
      DEFAULT_RATING_CONFIG.masterRankMinRating
    ),
    proRankMinRating: nonNegativeInt(
      s.proRankMinRating,
      DEFAULT_RATING_CONFIG.proRankMinRating
    )
  };
}

/** Coerces an arbitrary tier string to the enum, defaulting to AMATEUR. */
export function normalizeTier(tier) {
  const t = String(tier ?? '').toUpperCase();
  return TIER_ORDER.includes(t) ? t : 'AMATEUR';
}

/**
 * Rank for a rating under the configured bands. Floors are compared high→low so
 * the highest satisfied band wins (band gaps are tolerated — a rating at or
 * above a floor is in that rank even if the lower band's ceiling is lower).
 */
export function rankForRating(rating, config = DEFAULT_RATING_CONFIG) {
  const r = Number(rating) || 0;
  if (config.proRankMinRating > 0 && r >= config.proRankMinRating) return 'PRO';
  if (config.masterRankMinRating > 0 && r >= config.masterRankMinRating) return 'MASTER';
  return 'AMATEUR';
}

/** Logistic expected score of `rating` against `opponentRating` (0..1). */
export function expectedScore(rating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/** K-factor: provisional while a player has played fewer than the threshold. */
export function kFactorFor(matchesPlayed, config = DEFAULT_RATING_CONFIG) {
  const played = Number(matchesPlayed) || 0;
  return played < config.provisionalMatchCount
    ? config.provisionalKFactor
    : config.establishedKFactor;
}

export function isProvisional(matchesPlayed, config = DEFAULT_RATING_CONFIG) {
  return (Number(matchesPlayed) || 0) < config.provisionalMatchCount;
}

/**
 * New rating for one player. `score` is 1 (win), 0.5 (draw) or 0 (loss). The
 * opponent rating and this player's matches-played are pre-match snapshots.
 */
export function nextRating({
  rating,
  opponentRating,
  score,
  matchesPlayed = 0,
  config = DEFAULT_RATING_CONFIG
}) {
  const k = kFactorFor(matchesPlayed, config);
  return Math.round(rating + k * (score - expectedScore(rating, opponentRating)));
}

/**
 * Maps a match end reason to the rating event reason. Declaration-based
 * outcomes carry their own reason; anything else is a normal (played) result.
 */
export function reasonForEndReason(endReason) {
  const r = String(endReason ?? '').toLowerCase();
  if (r.includes('timeout')) return 'TIMEOUT';
  if (r.includes('resign')) return 'RESIGNATION';
  if (r.includes('disconnect') || r.includes('forfeit')) return 'DISCONNECT';
  return 'NORMAL';
}

export default {
  TIER_ORDER,
  DEFAULT_RATING_CONFIG,
  resolveRatingConfig,
  normalizeTier,
  rankForRating,
  expectedScore,
  kFactorFor,
  isProvisional,
  nextRating,
  reasonForEndReason
};

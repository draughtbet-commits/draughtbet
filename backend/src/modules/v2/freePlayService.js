/**
 * Free play — solo games against the server bot.
 *
 * A FREE_PLAY match is a normal Match row with three deliberate differences:
 *
 *   1. The bot occupies one of the two seats. It is a synthetic participant id
 *      (`bot:<matchId>`) and has no User row, so no MatchParticipant is
 *      created for it — only the human's side is recorded.
 *   2. The stake is zero. Nothing is ever reserved, released or paid out, and
 *      the ledger is not touched at all (the ledger refuses zero-amount
 *      entries by design, so a free game must never enter it).
 *   3. The match is unrated. `rated = false` keeps the Elo service out of the
 *      result entirely.
 *
 * The bot is a full opponent, not a prop: it plays the side the human did not
 * pick, under the same clock, and the same engine rules.
 */

import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { clampBotLevel, BOT_LEVELS } from '../engine/bot.js';

export const FREE_PLAY_MODE = 'FREE_PLAY';
export const RANKED_MODE = 'RANKED';

export const FREE_PLAY_SIDES = Object.freeze({ LIGHT: 'LIGHT', DARK: 'DARK' });

// The platform default clock is 60s per turn; free play may pick its own but
// never outside this window.
export const MIN_FREE_PLAY_TIME_CONTROL_SECONDS = 30;
export const MAX_FREE_PLAY_TIME_CONTROL_SECONDS = 600;

export class InvalidFreePlayRequestError extends Error {
  constructor(message = 'Invalid free play request') {
    super(message);
    this.name = 'InvalidFreePlayRequestError';
  }
}

/** The bot's participant id for a given match. */
export const botIdForMatch = (matchId) => `bot:${matchId}`;

/** True for a synthetic bot participant id. */
export const isBotId = (id) => typeof id === 'string' && id.startsWith('bot:');

/** True when the match row is a free-play game. */
export const isFreePlayMatch = (match) => Boolean(match) && match.mode === FREE_PLAY_MODE;

const normalizeSide = (side) => {
  const value = String(side ?? '').trim().toUpperCase();
  if (value === 'LIGHT' || value === 'WHITE') return FREE_PLAY_SIDES.LIGHT;
  if (value === 'DARK' || value === 'BLACK') return FREE_PLAY_SIDES.DARK;
  throw new InvalidFreePlayRequestError('Side must be LIGHT or DARK');
};

const resolveTimeControl = (requested, platformDefault) => {
  const parsed = Number.parseInt(String(requested ?? ''), 10);
  const fallback = Number.isInteger(platformDefault) && platformDefault > 0
    ? platformDefault
    : 60;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, MIN_FREE_PLAY_TIME_CONTROL_SECONDS), MAX_FREE_PLAY_TIME_CONTROL_SECONDS);
};

/**
 * Creates the match row for a free-play game. The game is live the moment it
 * exists (there is no funding step, no ready gate and no second player to
 * wait for), so the row lands directly in IN_PLAY with the clock snapshot.
 */
export const createFreePlayMatch = async ({
  userId,
  side,
  botLevel = BOT_LEVELS.MEDIUM,
  timeControlSeconds = null
}) => {
  if (!userId) throw new InvalidFreePlayRequestError('A player id is required');
  const humanSide = normalizeSide(side);
  const level = clampBotLevel(botLevel);

  const settings = await prisma.platformSettings.findUnique({
    where: { id: 'singleton' },
    select: { timeControlSeconds: true }
  });
  const control = resolveTimeControl(timeControlSeconds, settings?.timeControlSeconds);

  const matchId = crypto.randomUUID();
  const botId = botIdForMatch(matchId);
  const playerLightId = humanSide === FREE_PLAY_SIDES.LIGHT ? userId : botId;
  const playerDarkId = humanSide === FREE_PLAY_SIDES.DARK ? userId : botId;

  // Same versioned-config snapshot the competitive path takes, so a free game
  // is auditable against the rules it was played under.
  const rulesetDefId = await prisma.rulesetVersion.findFirst({
    where: { active: true },
    select: { id: true }
  });
  const configVersionId = await prisma.platformConfigVersion.findFirst({
    where: { activeTo: null },
    orderBy: { activeFrom: 'desc' },
    select: { id: true }
  });

  const match = await prisma.match.create({
    data: {
      id: matchId,
      playerLightId,
      playerDarkId,
      tier: 'AMATEUR',
      stakeMinorUnits: BigInt(0),
      status: 'IN_PLAY',
      rated: false,
      mode: FREE_PLAY_MODE,
      botLevel: level,
      botPlayerId: botId,
      // No money is involved, so there is no fee to freeze.
      settlementCommissionPercent: null,
      timeControlSeconds: control,
      currency: 'NGN',
      startedAt: new Date(),
      ...(rulesetDefId?.id ? { rulesetDefId: rulesetDefId.id } : {}),
      ...(configVersionId?.id ? { configVersionId: configVersionId.id } : {}),
      participants: {
        create: [{ userId, side: humanSide }]
      }
    }
  });

  logger.info({ matchId, userId, humanSide, level, control }, 'Free play match created');
  return { match, humanSide, level, botId, timeControlSeconds: control };
};

/**
 * The public shape of a free-play game for the client: which side the human
 * plays, how strong the bot is, and the clock it runs on.
 */
export const freePlaySnapshot = ({ match, humanSide, level, timeControlSeconds }) => ({
  matchId: match.id,
  mode: FREE_PLAY_MODE,
  side: humanSide,
  botLevel: level,
  botId: match.botPlayerId,
  timeControlSeconds,
  stakeMinorUnits: 0,
  rated: false
});

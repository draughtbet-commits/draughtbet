/**
 * REST lifecycle surface: open-match create/list/join, lifecycle snapshot,
 * and readiness that interlinks with the socket ready gate.
 */
import crypto from 'crypto';
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';
import {
  initializeGame,
  getGameState,
  startMatchGame
} from '../../sockets/gameManager.js';
import { buildStatePayload } from '../../sockets/gameProtocol.js';
import { getIO } from '../../sockets/index.js';
import { assertEligibleForMoney } from '../../services/eligibilityService.js';
import {
  lockWalletsInOrder,
  lockWalletForUpdate,
  ActiveMatchError
} from '../../services/matchService.js';
import { getLedgerAvailable } from '../../services/ledgerService.js';
import { reserveBothStakes } from '../stake/service.js';
import {
  MatchNotFoundError,
  NotParticipantError,
  MatchNotReadyError,
  transitionMatch
} from '../match/service.js';

export { MatchNotFoundError, NotParticipantError, MatchNotReadyError };

export class SelfJoinError extends Error {
  constructor(message = 'Cannot join your own open match') {
    super(message);
    this.name = 'SelfJoinError';
  }
}

export class JoinUnavailableError extends Error {
  constructor(message = 'This open match is no longer available') {
    super(message);
    this.name = 'JoinUnavailableError';
  }
}

export class TierMismatchError extends Error {
  constructor(message = 'Joiner tier does not match the match tier') {
    super(message);
    this.name = 'TierMismatchError';
  }
}

export class NotEligibleError extends Error {
  constructor(message = 'Player is not eligible to play') {
    super(message);
    this.name = 'NotEligibleError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient funds') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

// Internal marker: the joiner can afford the stake but the listing's creator
// cannot. It is translated to a plain InsufficientFundsError after the listing
// is retired, so callers still see a 402.
class ChallengerFundsUnavailableError extends Error {
  constructor() {
    super('Challenger no longer has funds for this match');
    this.name = 'ChallengerFundsUnavailableError';
  }
}

export const OPEN_MATCH_TTL_MS = (() => {
  const raw = Number(process.env.OPEN_MATCH_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();
export const RULESETS = new Set(['CLASSIC', 'INTERNATIONAL_10X10']);
export const VISIBILITIES = new Set(['PUBLIC', 'PRIVATE', 'ANYONE']);

// OPEN listings have no opponent yet; DARK is an empty placeholder so the rows
// keep the players-distinct CHECK, and is atomically replaced by the joiner at
// funding time. It never appears on a pre-terminal/live match.
const OPEN_SELF_PLACEHOLDER = '';

const SIDE_READY_KEY = { LIGHT: 'readyLight', DARK: 'readyDark' };

const asInt = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
};

const reserveSnapshot = (row) => ({
  userId: row.userId,
  amountMinorUnits: asInt(row.amountMinorUnits),
  status: row.status,
});

/**
 * Lifecycle snapshot the app parses: status, stake reservations, readiness
 * from the Redis projection, fee/preconditions and release/reason fields.
 */
export const buildLifecycleSnapshot = async (client, matchId, userId) => {
  const [match, settings, reservations] = await Promise.all([
    client.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        playerLightId: true,
        playerDarkId: true,
        stakeMinorUnits: true,
        settlementCommissionPercent: true,
        endReason: true,
        endedAt: true,
        cancelledAt: true,
        currency: true,
        timeControlSeconds: true
      }
    }),
    client.platformSettings.findUnique({ where: { id: 'singleton' } })
  ]);
  if (!match) throw new MatchNotFoundError();
  if (match.playerLightId !== userId && match.playerDarkId !== userId) {
    throw new NotParticipantError();
  }

  const stake = asInt(match.stakeMinorUnits) ?? 0;
  const commissionPercent =
    match.settlementCommissionPercent ??
    settings?.commissionPercent ??
    0;
  const feeMinor = Math.round((stake * (commissionPercent || 0)) / 100);
  const grossPotMinor = stake * 2 - feeMinor;
  const side = match.playerLightId === userId ? 'LIGHT' : 'DARK';
  const opponentId =
    side === 'LIGHT' ? match.playerDarkId : match.playerLightId;

  const opponentUser = opponentId
    ? await client.user.findUnique({
        where: { id: opponentId },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          tier: true
        }
      })
    : null;

  const isLight = side === 'LIGHT';
  const state = await getGameState(matchId);
  const youReady = Boolean(
    state && state[isLight ? 'readyLight' : 'readyDark'],
  );
  const opponentReady = Boolean(
    state && state[isLight ? 'readyDark' : 'readyLight'],
  );
  const presenceConnected = (field) => {
    if (!state || !state[field]) return true;
    try {
      const parsed = typeof state[field] === 'string'
        ? JSON.parse(state[field])
        : state[field];
      return parsed?.status !== 'disconnected';
    } catch (_) {
      return true;
    }
  };
  const youConnected = presenceConnected(isLight ? 'connLIGHT' : 'connDARK');
  const opponentConnected = presenceConnected(isLight ? 'connDARK' : 'connLIGHT');

  const reservationRows =
    reservations && reservations.length
      ? reservations
      : await client.stakeReservation.findMany({ where: { matchId } });
  const yourReservation = reservationRows.find(
    (r) => r.userId === userId,
  );
  const opponentReservation = reservationRows.find(
    (r) => r.userId === opponentId,
  );

  const stakeReleaseStatus = ['RELEASED', 'CANCELLED', 'EXPIRED'].includes(
    match.status,
  )
    ? 'COMPLETED'
    : undefined;

  return {
    id: match.id,
    status: match.status,
    stakeMinor: stake,
    feeMinor,
    grossPotMinor,
    timeControlSeconds: asInt(match.timeControlSeconds),
    opponent: opponentUser
      ? {
          id: opponentUser.id,
          username:
            opponentUser.username ?? opponentUser.displayName ?? 'Player',
          displayName: opponentUser.displayName,
          avatarId: opponentUser.avatar ?? 'avatar_01',
          tier: opponentUser.tier
        }
      : null,
    stakeReservations: reservationRows.map(reserveSnapshot),
    yourStake: yourReservation
      ? {
          status: yourReservation.status,
          amountMinorUnits: asInt(yourReservation.amountMinorUnits),
        }
      : { status: 'NONE', amountMinorUnits: 0 },
    opponentStake: opponentReservation
      ? {
          status: opponentReservation.status,
          amountMinorUnits: asInt(opponentReservation.amountMinorUnits),
        }
      : { status: 'NONE', amountMinorUnits: 0 },
    youReady,
    opponentReady,
    youConnected,
    opponentConnected,
    stakeReleaseStatus,
    reason:
      match.endReason ??
      (match.status === 'CANCELLED' ? 'CREATOR_CANCELLED' : null),
  };
};

const sideOf = (match, userId) => {
  if (match.playerLightId === userId) return 'LIGHT';
  if (match.playerDarkId === userId) return 'DARK';
  return null;
};

const broadcastState = async (matchId, state) => {
  const payload = buildStatePayload(matchId, state);
  if (!payload) return;
  const io = getIO();
  io.to(`match:${matchId}`).emit('match.state', payload);
};

const otherSideReady = (state, side) =>
  Boolean(state && state[side === 'LIGHT' ? 'readyDark' : 'readyLight']);

/**
 * Starts a funded match once both participants are marked ready on the
 * projection. Idempotent: a retry on a live match re-emits state only.
 */
export const startWhenBothReady = async (matchId, side) => {
  const state = await getGameState(matchId);
  if (!state || !otherSideReady(state, side)) return null;

  const {
    state: started,
    match: startedMatch,
    justStarted,
  } = await startMatchGame(matchId);
  const clock = {
    deadlineAt: Number(started.deadlineAt) > 0 ? Number(started.deadlineAt) : null,
    turnStartedAtServer:
      Number(started.turnStartedAtServer) > 0
        ? Number(started.turnStartedAtServer)
        : null,
    timeControlSeconds:
      Number(started.timeControlSeconds) > 0
        ? Number(started.timeControlSeconds)
        : null,
    serverNowMs: Date.now()
  };
  if (justStarted) {
    const io = getIO();
    io.to(`match:${matchId}`).emit('game.started', {
      matchId,
      stateVersion: Number(started.version ?? '0'),
      startedAt: startedMatch?.startedAt
        ? startedMatch.startedAt.getTime()
        : Date.now(),
      board:
        typeof started.board === 'string'
          ? JSON.parse(started.board)
          : started.board,
      clocks: clock
    });
  }
  await broadcastState(matchId, started);
  return started;
};

/**
 * Marks the participant ready (REST POST /matches/{id}/ready), records the
 * Redis ready marker (the same one the socket `player.ready` handler writes),
 * and fires the two-player start gate when both sides are ready.
 */
export const markReady = async (client, matchId, userId) => {
  const match = await client.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      playerLightId: true,
      playerDarkId: true,
      tier: true
    }
  });
  if (!match) throw new MatchNotFoundError();
  const side = sideOf(match, userId);
  if (!side) throw new NotParticipantError();

  if (match.status !== 'FUNDED' && match.status !== 'READY') {
    throw new MatchNotReadyError(
      'Only a funded, not-yet-started match can be marked ready'
    );
  }

  if (match.status === 'FUNDED') {
    await transitionMatch(client, matchId, 'READY');
  }

  const projection = await getGameState(matchId);
  if (!projection) {
    try {
      await initializeGame(
        matchId,
        match.playerLightId,
        match.playerDarkId,
        match.tier,
        { pending: true }
      );
    } catch (err) {
      logger.warn({ err, matchId }, 'ready: holding projection recreate failed');
    }
  }

  await redis.hset(`match:${matchId}`, { [SIDE_READY_KEY[side]]: String(Date.now()) });

  try {
    const started = await startWhenBothReady(matchId, side);
    if (started) {
      logger.info({ matchId, userId }, 'Match started (both ready)');
    } else {
      const refreshed = await getGameState(matchId);
      if (refreshed) await broadcastState(matchId, refreshed);
    }
  } catch (err) {
    logger.warn({ err, matchId }, 'ready: server-authoritative start failed');
  }

  return buildLifecycleSnapshot(client, matchId, userId);
};

/**
 * Creates an OPEN listing (POST /api/v1/matches). LIGHT = creator; DARK = a
 * transient self placeholder. The stake is NOT reserved until an opponent
 * joins, but the creator must be able to cover it: a listing the creator could
 * never fund only wastes an opponent's time (they hit the insufficient-funds
 * wall at join) and clogs the Arena, so the balance is verified up front.
 */
export const createOpenMatch = async ({
  creatorId,
  tier,
  stakeMinorUnits,
  timeControlSeconds,
  commissionPercent,
  currency = 'NGN'
}) => {
  const matchId = crypto.randomUUID();
  const openMatch = await prisma.$transaction(async (tx) => {
    await assertEligibleForMoney(tx, creatorId, {
      enforceTimeout: true,
      stakeMinorUnits: BigInt(stakeMinorUnits)
    });
    const wallet = await lockWalletForUpdate(tx, creatorId);
    const available = await getLedgerAvailable(
      tx,
      creatorId,
      wallet.currency ?? currency
    );
    if (available < BigInt(stakeMinorUnits)) {
      throw new InsufficientFundsError(
        'Insufficient funds to create this match'
      );
    }
    return tx.match.create({
      data: {
        id: matchId,
        playerLightId: creatorId,
        playerDarkId: OPEN_SELF_PLACEHOLDER,
        tier,
        stakeMinorUnits: BigInt(stakeMinorUnits),
        status: 'OPEN',
        settlementCommissionPercent: commissionPercent,
        timeControlSeconds,
        currency,
        participants: {
          create: [{ userId: creatorId, side: 'LIGHT' }]
        }
      }
    });
  });
  logger.info({ matchId, creatorId, tier }, 'Open match created');
  return openMatch;
};

/**
 * Creates a directed challenge: an OPEN match whose join is reserved for one
 * opponent. The opponent's money eligibility is enforced at join time, so
 * creating a challenge never probes another player's restrictions. Like an
 * open listing, the challenger must be able to fund their own stake now.
 */
export const createChallengeMatch = async ({
  creatorId,
  inviteeId,
  tier,
  stakeMinorUnits,
  timeControlSeconds,
  commissionPercent,
  currency = 'NGN'
}) => {
  const matchId = crypto.randomUUID();
  const match = await prisma.$transaction(async (tx) => {
    await assertEligibleForMoney(tx, creatorId, {
      enforceTimeout: true,
      stakeMinorUnits: BigInt(stakeMinorUnits)
    });
    const wallet = await lockWalletForUpdate(tx, creatorId);
    const available = await getLedgerAvailable(
      tx,
      creatorId,
      wallet.currency ?? currency
    );
    if (available < BigInt(stakeMinorUnits)) {
      throw new InsufficientFundsError(
        'Insufficient funds to create this challenge'
      );
    }
    return tx.match.create({
      data: {
        id: matchId,
        playerLightId: creatorId,
        playerDarkId: OPEN_SELF_PLACEHOLDER,
        tier,
        stakeMinorUnits: BigInt(stakeMinorUnits),
        status: 'OPEN',
        settlementCommissionPercent: commissionPercent,
        timeControlSeconds,
        currency,
        participants: { create: [{ userId: creatorId, side: 'LIGHT' }] },
        challenges: {
          create: {
            inviterId: creatorId,
            inviteeId,
            stakeMinorUnits: BigInt(stakeMinorUnits)
          }
        }
      }
    });
  });
  logger.info({ matchId, creatorId, inviteeId, tier }, 'Player challenge created');
  return match;
};

/** Any pre-terminal match the user already holds (optionally excluding one id). */
export const matchesJoinedOpenStatuses = (tx, userId, notMatchId) =>
  tx.match.findFirst({
    where: {
      status: { in: ['DRAFT', 'OPEN', 'FUNDED', 'READY', 'IN_PLAY', 'ACTIVE'] },
      id: notMatchId ? { not: notMatchId } : undefined,
      OR: [{ playerLightId: userId }, { playerDarkId: userId }]
    },
    select: { id: true }
  });

/**
 * Retires an OPEN listing whose creator can no longer fund it, so it stops
 * misleading other players. Best-effort: a failure here must never mask the
 * original funds error the joiner is owed.
 */
const expireUnfundableListing = async (matchId) => {
  try {
    await prisma.$transaction(async (tx) => {
      await transitionMatch(tx, matchId, 'EXPIRED');
      await tx.matchChallenge.updateMany({
        where: { matchId, status: 'PENDING' },
        data: { status: 'EXPIRED' }
      });
    });
  } catch (err) {
    logger.warn({ err, matchId }, 'Could not expire an unfundable open listing');
  }
};

/**
 * Funds an OPEN match when an opponent joins (POST /api/v1/matches/:id/join).
 * One tx: row-lock the listing, run tier/eligibility/occupancy checks, admit
 * the joiner as DARK, reserve both stakes, land FUNDED with activation intent.
 */
export const fundOpenMatch = async (joinerId, matchId, options = {}) => {
  try {
    return await fundOpenMatchTx(joinerId, matchId, options);
  } catch (err) {
    if (err instanceof ChallengerFundsUnavailableError) {
      // The creator's listing outlived their balance. Retire it and tell the
      // joiner the truth instead of blaming their own wallet.
      await expireUnfundableListing(matchId);
      throw new InsufficientFundsError(
        'This match is no longer available: the creator no longer has funds'
      );
    }
    throw err;
  }
};

const fundOpenMatchTx = async (joinerId, matchId, { tier: joinerTier } = {}) => {
  const funded = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM "Match" WHERE id = ${matchId} FOR UPDATE
    `;
    const match = rows && rows[0];
    if (!match) throw new MatchNotFoundError();

    if (match.status !== 'OPEN') {
      throw new JoinUnavailableError('This open match is no longer open');
    }
    if (Date.now() - new Date(match.createdAt).getTime() > OPEN_MATCH_TTL_MS) {
      await transitionMatch(tx, matchId, 'EXPIRED');
      await tx.matchChallenge.updateMany({
        where: { matchId },
        data: { status: 'EXPIRED' }
      });
      throw new JoinUnavailableError('This open match has expired');
    }
    if (match.playerLightId === joinerId) {
      throw new SelfJoinError();
    }
    if (joinerTier && joinerTier !== match.tier) {
      throw new TierMismatchError();
    }

    // Directed challenges restrict the join authority to the invitee only.
    const challenge = await tx.matchChallenge.findFirst({
      where: { matchId },
      select: {
        id: true,
        inviteeId: true,
        status: true,
        createdAt: true
      }
    });
    if (challenge) {
      if (challenge.inviteeId !== joinerId) {
        throw new JoinUnavailableError('This challenge is directed at another player');
      }
      if (challenge.status !== 'PENDING') {
        throw new JoinUnavailableError('This challenge is no longer pending');
      }
      if (Date.now() - new Date(challenge.createdAt).getTime() > OPEN_MATCH_TTL_MS) {
        await transitionMatch(tx, matchId, 'EXPIRED');
        await tx.matchChallenge.update({
          where: { id: challenge.id },
          data: { status: 'EXPIRED' }
        });
        throw new JoinUnavailableError('This challenge has expired');
      }
    }

    const [challenger, joiner] = await Promise.all([
      tx.user.findUnique({
        where: { id: match.playerLightId },
        select: { id: true, tier: true, isBanned: true }
      }),
      tx.user.findUnique({
        where: { id: joinerId },
        select: { id: true, tier: true, isBanned: true }
      })
    ]);
    if (!challenger || challenger.isBanned) {
      throw new NotEligibleError('Challenger is not eligible to play');
    }
    if (!joiner || joiner.isBanned) {
      throw new NotEligibleError('Joiner is not eligible to play');
    }

    const stakeAmount = BigInt(match.stakeMinorUnits);
    await assertEligibleForMoney(tx, match.playerLightId, {
      enforceTimeout: true,
      stakeMinorUnits: stakeAmount
    });
    await assertEligibleForMoney(tx, joinerId, {
      enforceTimeout: true,
      stakeMinorUnits: stakeAmount
    });

    // The joiner must not hold another pre-terminal match. The creator's own
    // OPEN listing is this match, so it is excluded below.
    const competing = await matchesJoinedOpenStatuses(tx, joinerId, matchId);
    if (competing) {
      throw new ActiveMatchError('You already have an active match');
    }

    const [wLight, wDark] = await lockWalletsInOrder(
      tx,
      match.playerLightId,
      joinerId
    );
    const availableLight = await getLedgerAvailable(
      tx,
      match.playerLightId,
      wLight.currency ?? 'NGN'
    );
    const availableDark = await getLedgerAvailable(
      tx,
      joinerId,
      wDark.currency ?? 'NGN'
    );
    if (availableDark < stakeAmount) {
      // The joiner cannot cover their own side.
      throw new InsufficientFundsError('Insufficient funds for stake');
    }
    if (availableLight < stakeAmount) {
      // The listing's creator cannot cover theirs; attribute it correctly.
      throw new ChallengerFundsUnavailableError();
    }

    await tx.match.update({
      where: { id: matchId },
      data: { playerDarkId: joinerId }
    });
    await tx.matchParticipant.create({
      data: { matchId, userId: joinerId, side: 'DARK' }
    });

    await reserveBothStakes(tx, {
      matchId,
      participants: [
        { userId: match.playerLightId },
        { userId: joinerId }
      ],
      amountMinorUnits: stakeAmount,
      wallets: [wLight, wDark]
    });

    await tx.matchChallenge.updateMany({
      where: { matchId },
      data: { status: 'ACCEPTED' }
    });

    const funded = await transitionMatch(tx, matchId, 'FUNDED');

    await tx.gameOutbox.create({
      data: {
        matchId,
        player1Id: match.playerLightId,
        player2Id: joinerId,
        tier: match.tier,
        stakeMinorUnits: stakeAmount,
        status: 'PENDING'
      }
    });

    return funded;
  });

  return funded;
};

/**
 * Shapes an OPEN Match row into the listing object the app parses (id, stake,
 * time control, ruleset, visibility, expiry, public creator).
 */
export const openMatchListing = (match, currency = 'NGN') => {
  const light = match.participants?.find((p) => p.side === 'LIGHT');
  const creator = light?.user ?? match.creator;
  return {
    id: match.id,
    stakeMinor: asInt(match.stakeMinorUnits),
    timeControlSeconds: asInt(match.timeControlSeconds),
    ruleset: match.rulesetVersion ? 'INTERNATIONAL_10X10' : 'CLASSIC',
    visibility: 'PUBLIC',
    board: 'Server configured',
    expiresAt: new Date(
      new Date(match.createdAt).getTime() + OPEN_MATCH_TTL_MS
    ).toISOString(),
    creator: {
      id: creator?.id ?? match.playerLightId,
      username: creator?.username ?? creator?.fullName ?? 'Player',
      displayName: creator?.displayName,
      avatarId: creator?.avatar ?? 'avatar_01',
      rank: creator?.tier ?? match.tier,
      rating: null
    }
  };
};

/** OPEN listings in the viewer's tier, excluding their own, still within TTL. */
export const listOpenMatches = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true }
  });
  if (!user) throw new Error('User not found');

  const since = new Date(Date.now() - OPEN_MATCH_TTL_MS);
  const matches = await prisma.match.findMany({
    where: {
      status: 'OPEN',
      tier: user.tier,
      playerLightId: { not: userId },
      createdAt: { gt: since },
      challenges: { none: {} }
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      participants: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              tier: true,
              fullName: true
            }
          }
        }
      }
    }
  });

  return matches.map((m) => openMatchListing(m));
};

/** Every pre-start match the user holds (OPEN / FUNDED / READY) as a lifecycle
 *  snapshot, newest first. Lets the app Home surface stranded pre-play matches.
 */
export const listActiveMatches = async (userId) => {
  const rows = await prisma.match.findMany({
    where: {
      status: { in: ['OPEN', 'FUNDED', 'READY'] },
      OR: [{ playerLightId: userId }, { playerDarkId: userId }]
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true }
  });
  const snapshots = await Promise.all(
    rows.map(({ id }) =>
      buildLifecycleSnapshot(prisma, id, userId).catch((err) => {
        logger.warn({ err, matchId: id }, 'active match snapshot failed');
        return null;
      })
    )
  );
  return snapshots.filter((snapshot) => snapshot !== null);
};

export default {
  buildLifecycleSnapshot,
  markReady,
  createOpenMatch,
  createChallengeMatch,
  fundOpenMatch,
  listOpenMatches,
  listActiveMatches,
  openMatchListing,
  startWhenBothReady
};
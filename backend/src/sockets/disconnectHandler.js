import redis from '../utils/redis.js';
import prisma from '../utils/db.js';
import { getIO } from './index.js';
import {
  authoritativeNowMs,
  getActiveGameForUser,
  getGameState,
  runAfterJoinHook
} from './gameManager.js';
import { reconcileRedisWithDurable } from './gameRecovery.js';
import { getLegalMoves } from '../modules/engine/index.js';
import { buildStatePayload } from './gameProtocol.js';
import { validateMatchIdPayload } from './payloadGuard.js';
import { resolveDisconnectGraceMs, GAME_STATE_TTL_SECONDS, DEFAULT_TIME_CONTROL_SECONDS } from './timeControl.js';
import { recordConnectionEvent, recordGameEvent } from './connectionEvidence.js';
import logger from '../utils/logger.js';
import { NotificationService } from '../modules/notification/service.js';
import { isLiveStatus } from '../modules/match/service.js';
import { FREE_PLAY_MODE } from '../modules/v2/freePlayService.js';

// Room budget per connection: every socket owns its personal `user:<id>` room,
// so this is the cap on the personal room plus match rooms.
const MAX_ROOMS_PER_CONNECTION = 5;

// Records a participant's presence on the live projection so `match.state`
// exposes `connection` states synchronously. Authority remains the `disconnects`
// zset (consumed by the disconnect sweep); this is a best-effort projection.
const recordPresence = async (matchId, state, userId, status, graceEndsAt = null) => {
  const side = state && state.player1 === userId ? 'LIGHT' : state && state.player2 === userId ? 'DARK' : null;
  if (!side) return;
  await writePresence(matchId, side, userId, status, graceEndsAt);
};

export const writePresence = async (matchId, side, userId, status, graceEndsAt = null) => {
  // A falsy matchId would otherwise be interpolated into `match:undefined` and
  // create a stray key. Presence is best-effort, so skip rather than write junk.
  if (!matchId) {
    logger.warn({ userId, side, status }, 'Presence write skipped: missing matchId');
    return;
  }
  const field = `conn${side}`;
  const value = status === 'disconnected'
    ? JSON.stringify({ status, graceEndsAt: graceEndsAt ?? null })
    : JSON.stringify({ status });
  try {
    // HSET and EXPIRE are issued together so a presence write can never leave a
    // `match:` key with no lifetime (the bug that produced `match:undefined`).
    await redis.multi()
      .hset(`match:${matchId}`, { [field]: value })
      .expire(`match:${matchId}`, GAME_STATE_TTL_SECONDS)
      .exec();
  } catch (err) {
    logger.warn({ err, matchId, userId }, 'Record presence failed');
  }
};

/**
 * Records presence as connected, but only reports a change when the player was
 * not already present.
 *
 * Decided with a single atomic Lua call: a read-then-write would let two
 * concurrent joins from the same player both observe "disconnected" and both
 * report a transition, so a duplicated presence notification would still reach
 * the opponent. Returns true only on a genuine disconnected -> connected edge,
 * which is what makes the notification safe to trigger a client resync from.
 */
export const markPresenceIfChanged = async (matchId, side, userId) => {
  if (!matchId) {
    logger.warn({ userId, side }, 'Presence write skipped: missing matchId');
    return false;
  }
  const field = `conn${side}`;
  try {
    const result = await redis.eval(
      markConnectedIfChangedScript,
      1,
      `match:${matchId}`,
      field,
      JSON.stringify({ status: 'connected' }),
      String(GAME_STATE_TTL_SECONDS)
    );
    return Number(result) === 1;
  } catch (err) {
    // Best-effort: fall back to writing presence so the seat is still recorded,
    // but report "changed" so the notification is not silently withheld.
    logger.warn({ err, matchId, userId }, 'markPresenceIfChanged failed; writing presence directly');
    await writePresence(matchId, side, userId, 'connected');
    return true;
  }
};

// HGET the field, set it only if it does not already record a connection, and
// always refresh the key TTL. Returns 1 when the value changed.
// KEYS[1] = match key, ARGV[1] = field, ARGV[2] = value, ARGV[3] = TTL (string)
const markConnectedIfChangedScript = `
local current = redis.call("HGET", KEYS[1], ARGV[1])
local wasConnected = 0
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == "table" and decoded["status"] == "connected" then
    wasConnected = 1
  end
end
if wasConnected == 0 then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
end
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
if wasConnected == 1 then return 0 end
return 1
`;

export async function handleDisconnect(socket) {
  const userId = socket.user?.userId;
  if (!userId) return;

  try {
    // Only the last socket for this user marks them disconnected; closing a
    // second tab must not start the grace timer or warn the opponent.
    try {
      const remaining = await getIO().in(`user:${userId}`).fetchSockets();
      if (remaining.some((s) => s.user?.userId === userId)) return;
    } catch (err) {
      logger.warn({ err, userId }, 'Disconnect: socket liveness check failed');
    }

    const matchId = await getActiveGameForUser(userId);
    const preStart = await isPreStartMatch(matchId);
    if (preStart) {
      // Pre-start (FUNDED/READY) disconnect: the match is not live yet, so the
      // opponent is told directly about the dropped connection so the app can
      // surface the disconnected-before-start state. Note the match may hold an
      // activeMatch pointer even before play starts (the holding projection is
      // reserved at funding), so this branch keys on durable status instead of
      // pointer absence.
      await notifyPreStartDisconnect(userId, socket);
      return;
    }

    const state = await getGameState(matchId);
    const grace = resolveDisconnectGraceMs(state);

    await redis.zadd('disconnects', Date.now() + grace, `${matchId}:${userId}`);

    await recordPresence(matchId, state, userId, 'disconnected', Date.now() + grace);

    socket.to(`match:${matchId}`).emit('opponent_disconnected', {
      userId,
      gracePeriodMs: grace
    });
    socket.to(`match:${matchId}`).emit('opponent.connection', {
      userId,
      status: 'disconnected',
      graceEndsAt: Date.now() + grace
    });

    await recordConnectionEvent({ matchId, userId, state: 'DISCONNECTED', socket });
    await recordGameEvent({
      matchId,
      playerId: userId,
      type: 'DISCONNECT',
      payload: { graceMs: grace }
    });

    await NotificationService.create(
      userId,
      'DISCONNECT_WARNING',
      'Connection Lost',
      `You have ${Math.round(grace / 1000)} seconds to reconnect before forfeiting your match.`,
      `/match/${matchId}`,
      matchId
    );

    logger.info({ userId, matchId, graceMs: grace },
      'Player disconnected, started grace period and sent warning');
  } catch (err) {
    logger.error({ err, userId }, 'Error handling disconnect');
  }
}

/**
 * A participant's socket dropped while the match is still pre-play (FUNDED or
 * READY, no live game). The opponent gets a direct presence ping the same way a
 * live disconnect pings the match room, so the parked app can surface the
 * disconnected-before-start state without polling. Best-effort: the match may
 * have been concurrently released.
 */
/**
 * True when the user's active match is still pre-play (FUNDED/READY). The
 * holding projection reserves an activeMatch pointer at funding, so a live
 * disconnect is distinguished from a pre-start one by the durable status.
 */
async function isPreStartMatch(matchId) {
  if (!matchId) return true;
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true }
    });
    return !!match && (match.status === 'FUNDED' || match.status === 'READY');
  } catch (err) {
    logger.warn({ err, matchId }, 'isPreStartMatch: status lookup failed');
    return false;
  }
}

async function notifyPreStartDisconnect(userId, socket) {
  try {
    const match = await prisma.match.findFirst({
      where: {
        status: { in: ['FUNDED', 'READY'] },
        OR: [{ playerLightId: userId }, { playerDarkId: userId }]
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        playerLightId: true,
        playerDarkId: true
      }
    });
    if (!match) return;

    const opponentId =
      match.playerLightId === userId ? match.playerDarkId : match.playerLightId;
    await writePresence(match.id, match.playerLightId === userId ? 'LIGHT' : 'DARK', userId, 'disconnected');

    // Pre-start there is no live turn clock to protect, but the waiting window
    // is still bounded, so report the same resolved grace the mid-game path
    // sends. Omitting it left the client with a null countdown and no idea how
    // long the opponent has.
    const preStartGrace = resolveDisconnectGraceMs(match);

    socket.to(`user:${opponentId}`).emit('opponent_disconnected', {
      userId,
      gracePeriodMs: preStartGrace,
      preStart: true
    });
    socket.to(`user:${opponentId}`).emit('opponent.connection', {
      userId,
      status: 'disconnected',
      graceEndsAt: Date.now() + preStartGrace,
      preStart: true
    });
    logger.info({ userId, matchId: match.id }, 'Pre-start opponent disconnect notified');
  } catch (err) {
    logger.warn({ err, userId }, 'Pre-start disconnect notify failed');
  }
}

export async function handleJoinMatch(socket, payload) {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateMatchIdPayload(payload);
  if (!validated.ok) {
    socket.emit('error', { message: 'Invalid payload' });
    return;
  }
  const { matchId } = validated.data;

  try {
    // AUTHORIZE BEFORE any room/presence mutation: a third account must
    // receive neither room membership nor game state, and cannot spoof a
    // reconnection notification. Knowledge of a match id is not authorization.
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, mode: true, playerLightId: true, playerDarkId: true }
    });

    if (!match) {
      socket.emit('error', { message: 'Match not found' });
      return;
    }
    if (match.playerLightId !== userId && match.playerDarkId !== userId) {
      socket.emit('error', { message: 'Not a participant' });
      return;
    }

    // Limit per-connection rooms so one connection cannot hoard arbitrary rooms.
    if (socket.rooms.size >= MAX_ROOMS_PER_CONNECTION) {
      socket.emit('error', { message: 'Too many rooms' });
      return;
    }

    await redis.zrem('disconnects', `${matchId}:${userId}`);
    socket.join(`match:${matchId}`);

    // Pre-play matches have no game projection yet -- the board is created when
    // a player enters, not when they take a seat. Requiring the projection here
    // rejected every seated player with "Game not found", which left the room
    // permanently unsynced and the Enter action permanently disabled. Record
    // presence and return instead.
    if (match.status === 'FUNDED' || match.status === 'READY') {
      const side = match.playerLightId === userId ? 'LIGHT' : 'DARK';
      // Notify the opponent only when this join actually MOVES their presence
      // from disconnected to connected. Emitting on every join made presence an
      // echo: the opponent's client resyncs (re-joins) on hearing "connected",
      // which notifies us, which makes us resync and re-join -- a mutual loop
      // that pinned both clients at ~20 joins/second until the per-user
      // match.join budget was spent and room entry stopped working.
      const becamePresent = await markPresenceIfChanged(matchId, side, userId);
      if (becamePresent) {
        socket.to(`user:${userId === match.playerLightId ? match.playerDarkId : match.playerLightId}`)
          .emit('opponent.connection', { userId, status: 'connected', preStart: true });
      }
      logger.info({ userId, matchId, becamePresent }, 'Player seated in pre-play match room');
      return;
    }

    // Reconcile the live projection against the durable log before serving it:
    // a restart or Redis loss must surface the canonical board, never a stale
    // or missing one.
    let state = await reconcileRedisWithDurable(matchId);
    if (!state) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    // A free-play game opens its clock when the player is actually in the
    // room: the match row is live from the start (so the game is never
    // stranded), but the first turn must not burn while the client is still
    // navigating to the board.
    if (state.status === 'ready_pending' && match.mode === FREE_PLAY_MODE) {
      const nowMs = Date.now();
      const control = Number(state.timeControlSeconds) > 0
        ? Number(state.timeControlSeconds)
        : DEFAULT_TIME_CONTROL_SECONDS;
      await redis.hset(`match:${matchId}`, {
        status: 'in_progress',
        deadlineAt: String(nowMs + control * 1000),
        turnStartedAtServer: String(nowMs)
      });
      state = { ...state, status: 'in_progress', deadlineAt: String(nowMs + control * 1000), turnStartedAtServer: String(nowMs) };
    }

    const board = JSON.parse(state.board);
    const currentTurn = state.currentTurn;
    const legalMoves = getLegalMoves(board, currentTurn);
    const nowMs = await authoritativeNowMs();

    // Legacy `game_state` (raw Redis hash + legalMoves) plus the canonical
    // V2 `match.state` resync payload. The app migrates to the latter.
    socket.emit('game_state', {
      ...state,
      legalMoves
    });
    const canonical = buildStatePayload(matchId, state, nowMs);
    if (canonical) socket.emit('match.state', canonical);

if (isLiveStatus(match.status)) {
      // Same echo hazard as the pre-play branch: notifying on every join makes
      // the opponent resync, which re-joins, which notifies us. Gate both
      // notifications on a real disconnected -> connected edge.
      const side = state.player1 === userId ? 'LIGHT' : state.player2 === userId ? 'DARK' : null;
      const becamePresent = side
        ? await markPresenceIfChanged(matchId, side, userId)
        : true;
      if (!side) await recordPresence(matchId, state, userId, 'connected');
      if (becamePresent) {
        socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
        socket.to(`match:${matchId}`).emit('opponent.connection', {
          userId,
          status: 'connected'
        });
      }
      await recordConnectionEvent({ matchId, userId, state: 'RECONNECTED', socket });
    }
    // A free-play game may have the bot on the move (the human plays dark);
    // the hook lets the bot open the game.
    await runAfterJoinHook(matchId);
    logger.info({ userId, matchId }, 'Player reconnected and joined match room');
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Error handling join match');
    socket.emit('error', { message: 'Failed to join match' });
  }
}

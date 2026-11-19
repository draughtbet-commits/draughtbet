/**
 * High-Stakes Multi-Match Gameplay Scenario
 * Exercises direct P2P Callouts (MASTER up to NGN 100,000, PRO up to NGN 250,000)
 * AND Redis Matchmaking Queue Waves across AMATEUR (NGN 5,000), MASTER (NGN 30,000),
 * and PRO (NGN 60,000) presets. Every match connects independent Socket.IO clients,
 * emits `match.join`, `clock.sync`, plays real engine-validated Draughts moves via
 * `move.submit`, settles via `match.resign`, and allows multi-round rematches.
 */
import crypto from 'node:crypto';
import { io as createSocketClient } from 'socket.io-client';
import { COLOR_BLACK, COLOR_WHITE, getLegalMoves } from '../../modules/engine/index.js';

const QUEUE_STAKE_BY_TIER = Object.freeze({
  AMATEUR: '500000',     // NGN 5,000
  MASTER: '3000000',     // NGN 30,000
  PRO: '6000000'         // NGN 60,000
});

const CALLOUT_STAKE_BY_TIER = Object.freeze({
  MASTER: '2000000',     // NGN 20,000
  PRO: '5000000'         // NGN 50,000
});

async function connectPlayerSocket(runner, userState, allowRefresh = true) {
  try {
    return await new Promise((resolve, reject) => {
      const socket = createSocketClient(runner.baseOrigin, {
        auth: { token: userState.accessToken },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 10_000
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error(`${userState.label} Socket.IO connection timeout`));
      }, 10_000);

      socket.once('connect', () => {
        clearTimeout(timer);
        userState.socketConnected = true;
        resolve(socket);
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(new Error(`${userState.label} Socket.IO error: ${err.message}`));
      });
    });
  } catch (err) {
    if (allowRefresh && typeof runner?.refreshUserSession === 'function') {
      const refreshed = await runner.refreshUserSession(userState);
      if (refreshed) {
        return connectPlayerSocket(runner, userState, false);
      }
    }
    throw err;
  }
}

function waitForAnyEvent(socket, eventNames, timeoutMs = 4500) {
  return new Promise((resolve) => {
    let settled = false;
    const handlers = new Map();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      for (const [ev, fn] of handlers) socket.off(ev, fn);
      resolve(null);
    }, timeoutMs);

    for (const ev of eventNames) {
      const handler = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const [name, fn] of handlers) socket.off(name, fn);
        resolve({ event: ev, payload });
      };
      handlers.set(ev, handler);
      socket.once(ev, handler);
    }
  });
}

async function playLiveMatchOnSockets(runner, matchPayload, lightUser, darkUser, socketLight, socketDark, movesTarget = 4) {
  const matchId = matchPayload?.id || matchPayload?.matchId;
  if (!matchId || !lightUser || !darkUser || !socketLight || !socketDark) {
    return { ok: false, skipped: true };
  }

  lightUser.currentActivity = 'MATCH_GAMEPLAY';
  darkUser.currentActivity = 'MATCH_GAMEPLAY';
  lightUser.currentMatchId = matchId;
  darkUser.currentMatchId = matchId;

  try {
    const joinL = waitForAnyEvent(socketLight, ['match.state'], 5000);
    const joinD = waitForAnyEvent(socketDark, ['match.state'], 5000);
    socketLight.emit('match.join', { matchId });
    socketDark.emit('match.join', { matchId });
    await Promise.all([joinL, joinD]);

    // Exercise authoritative clock sync on match start
    socketLight.emit('clock.sync', { matchId, clientSentAt: Date.now() });

    let playedMoves = 0;
    for (let ply = 0; ply < movesTarget; ply++) {
      const stateRes = await runner.apiCall(lightUser, 'GET', `/matches/${matchId}/state`);
      const st = stateRes.json;
      if (!st || st.status !== 'in_progress') break;

      const board = Array.isArray(st.board) ? st.board : JSON.parse(st.board);
      const turnColor = st.currentTurn === COLOR_BLACK ? COLOR_BLACK : COLOR_WHITE;
      const activeUser = turnColor === COLOR_WHITE ? lightUser : darkUser;
      const activeSocket = turnColor === COLOR_WHITE ? socketLight : socketDark;

      const legalMoves = Array.isArray(st.legalMoves) && st.legalMoves.length > 0
        ? st.legalMoves
        : getLegalMoves(board, turnColor);
      if (legalMoves.length === 0) break;

      const chosen = legalMoves[ply % legalMoves.length];
      const acceptedPromise = waitForAnyEvent(activeSocket, ['move.accepted', 'move.rejected'], 5000);
      const runTag = runner.runId || lightUser.runId || 'sim';
      const clientMoveId = `sim_${runTag}_${crypto.randomBytes(4).toString('hex')}`;
      activeSocket.emit('move.submit', {
        matchId,
        clientMoveId,
        expectedStateVersion: Number(st.version ?? 0),
        from: chosen.from,
        to: chosen.to,
        ...(Array.isArray(chosen.path) && chosen.path.length >= 2 ? { path: chosen.path } : {})
      });
      const reply = await acceptedPromise;
      if (reply?.event === 'move.accepted') {
        playedMoves += 1;
        runner.metrics.movesPlayed += 1;
      } else {
        break;
      }
    }

    const endedPromise = waitForAnyEvent(socketLight, ['game_over', 'match.ended', 'match.settled'], 6000);
    socketDark.emit('match.resign', { matchId });
    await endedPromise;

    if (runner.metrics.matchesCompleted < 20) {
      await Promise.all([
        runner.apiCall(lightUser, 'GET', '/matches/history'),
        runner.apiCall(darkUser, 'GET', '/matches/history')
      ]);
    }

    runner.metrics.matchesCompleted += 1;
    if (runner.metrics.matchesCompleted <= 30 || runner.metrics.matchesCompleted % 10 === 0) {
      runner.logActivity(
        `${lightUser.label} vs ${darkUser.label} [${matchPayload.tier || lightUser.targetTier}] settled match ${matchId.slice(0, 8)} (${playedMoves} moves, stake=${matchPayload.stakeMinorUnits})`,
        { event: 'match.settled', matchId }
      );
    }

    lightUser.completedWorkflows += 1;
    darkUser.completedWorkflows += 1;
    return { ok: true, matchId, playedMoves };
  } finally {
    lightUser.currentMatchId = null;
    darkUser.currentMatchId = null;
    lightUser.currentActivity = 'IDLE';
    darkUser.currentActivity = 'IDLE';
  }
}

async function runCalloutPairMatch(runner, playerA, playerB, tier, sampleOpenCheck = false) {
  const stakeMinorUnits = CALLOUT_STAKE_BY_TIER[tier];
  if (!stakeMinorUnits || playerA.insufficientFunds || playerB.insufficientFunds) {
    return { ok: false, skipped: true };
  }

  let socketA = null;
  let socketB = null;
  try {
    const created = await runner.apiCall(
      playerA,
      'POST',
      '/callouts',
      { body: { stakeMinorUnits } },
      [201, 402, 403, 409]
    );
    if (created.status === 402) playerA.insufficientFunds = true;
    if (created.status !== 201 || !created.json?.callout?.id) {
      return { ok: false, skipped: true };
    }

    if (sampleOpenCheck) {
      await runner.apiCall(playerB, 'GET', '/callouts/open');
    }
    const accepted = await runner.apiCall(
      playerB,
      'POST',
      `/callouts/${created.json.callout.id}/accept`,
      {},
      [200, 402, 403, 409]
    );
    if (accepted.status === 402) playerB.insufficientFunds = true;
    const match = accepted.json?.match;
    if (accepted.status !== 200 || !match?.id) {
      return { ok: false, skipped: true };
    }

    [socketA, socketB] = await Promise.all([
      connectPlayerSocket(runner, playerA),
      connectPlayerSocket(runner, playerB)
    ]);

    const lightUser = match.playerLightId === playerA.userId ? playerA : playerB;
    const darkUser = match.playerLightId === playerA.userId ? playerB : playerA;
    const socketLight = lightUser.userId === playerA.userId ? socketA : socketB;
    const socketDark = darkUser.userId === playerA.userId ? socketA : socketB;

    return await playLiveMatchOnSockets(
      runner,
      { ...match, tier, stakeMinorUnits },
      lightUser,
      darkUser,
      socketLight,
      socketDark,
      2
    );
  } finally {
    if (socketA) {
      socketA.disconnect();
      playerA.socketConnected = false;
    }
    if (socketB) {
      socketB.disconnect();
      playerB.socketConnected = false;
    }
  }
}

async function runTierQueueBatch(runner, batchUsers, tier) {
  const readyUsers = batchUsers.filter((u) => Boolean(u.accessToken && u.userId));
  if (readyUsers.length < 2) return [];

  const stakeMinorUnits = QUEUE_STAKE_BY_TIER[tier] || '500000';
  const usersByUserId = new Map(readyUsers.map((u) => [u.userId, u]));
  const socketsByUserId = new Map();
  const discoveredMatches = new Map();
  const expectedMatchCount = Math.floor(readyUsers.length / 2);

  try {
    await Promise.all(
      readyUsers.map(async (u) => {
        const socket = await connectPlayerSocket(runner, u);
        socket.on('match_found', (payload) => {
          const id = payload?.id || payload?.matchId;
          if (id && !discoveredMatches.has(id)) {
            discoveredMatches.set(id, payload);
          }
        });
        socketsByUserId.set(u.userId, socket);
      })
    );

    await runner.runConcurrentBatches(readyUsers, async (u) => {
      u.currentActivity = 'MATCHMAKING_QUEUE';
      await runner.apiCall(
        u,
        'POST',
        '/matchmaking/join',
        { body: { stakeMinorUnits } },
        [200, 201, 402, 403, 409]
      );
    });

    const waitDeadline = Date.now() + Math.min(45_000, Math.max(20_000, expectedMatchCount * 2000));
    while (discoveredMatches.size < expectedMatchCount && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (discoveredMatches.size < expectedMatchCount) {
      const matchedIds = new Set();
      for (const m of discoveredMatches.values()) {
        matchedIds.add(m.playerLightId);
        matchedIds.add(m.playerDarkId);
      }
      const unmatched = readyUsers.filter((u) => !matchedIds.has(u.userId));
      if (unmatched.length > 0) {
        await runner.runConcurrentBatches(unmatched, async (u) => {
          await runner.apiCall(u, 'POST', '/matchmaking/leave', { body: { stakeMinorUnits } }, [200, 400, 404]);
          u.currentActivity = 'IDLE';
        });
      }
    }

    const results = [];
    await runner.runConcurrentBatches([...discoveredMatches.values()], async (matchPayload) => {
      const lightUser = usersByUserId.get(matchPayload.playerLightId);
      const darkUser = usersByUserId.get(matchPayload.playerDarkId);
      const socketLight = socketsByUserId.get(matchPayload.playerLightId);
      const socketDark = socketsByUserId.get(matchPayload.playerDarkId);
      const res = await playLiveMatchOnSockets(
        runner,
        matchPayload,
        lightUser,
        darkUser,
        socketLight,
        socketDark,
        2
      );
      results.push(res);
    });
    return results;
  } finally {
    for (const u of readyUsers) {
      const sock = socketsByUserId.get(u.userId);
      if (sock) sock.disconnect();
      u.socketConnected = false;
      u.currentActivity = 'IDLE';
      u.currentMatchId = null;
    }
  }
}

export async function runMatchmakingWave(runner, users, round = 0) {
  const ready = users.filter((u) => Boolean(u.accessToken && u.userId));
  if (ready.length < 2) return [];

  // Probe AMATEUR callout restriction cleanly once in round 0
  if (round === 0) {
    const amateurUser = ready.find((u) => (u.targetTier || 'AMATEUR') === 'AMATEUR');
    if (amateurUser) {
      const probe = await runner.apiCall(
        amateurUser,
        'POST',
        '/callouts',
        { body: { stakeMinorUnits: '50000' } },
        [201, 402, 403, 409]
      );
      if (probe.status === 403) {
        runner.recordGap('callout.tier_restricted', {
          status: 403,
          detail: 'AMATEUR tier callout creation disabled (amateurCalloutMaxP = 0).'
        });
      }
    }
  }

  const byTier = {
    PRO: ready.filter((u) => u.targetTier === 'PRO'),
    MASTER: ready.filter((u) => u.targetTier === 'MASTER'),
    AMATEUR: ready.filter((u) => !u.targetTier || u.targetTier === 'AMATEUR')
  };

  // 1. Direct P2P High-Stakes Callout Wave (PRO @ NGN 50,000, MASTER @ NGN 20,000)
  for (const tier of ['PRO', 'MASTER']) {
    const tierUsers = byTier[tier].filter((u) => !u.insufficientFunds);
    const calloutPairs = [];
    // Shift pairing offset across rounds so players battle different opponents back-to-back
    const offset = round % 2 === 1 ? 1 : 0;
    for (let i = offset; i + 1 < tierUsers.length; i += 2) {
      calloutPairs.push([tierUsers[i], tierUsers[i + 1], i === offset]);
    }
    if (calloutPairs.length > 0) {
      runner.logActivity(`Launching ${calloutPairs.length} ${tier} high-stakes callout matches (round ${round + 1})`, {
        event: 'callout.wave_started'
      });
      await runner.runConcurrentBatches(calloutPairs, async ([a, b, sampleOpen]) => {
        await runCalloutPairMatch(runner, a, b, tier, round === 0 && sampleOpen);
      });
    }
  }

  // 2. Rotated AMATEUR Redis Matchmaking Queue Wave on even rounds (48 players / wave)
  const QUEUE_BATCH_SIZE = 48;
  const amateurUsers = byTier.AMATEUR.filter((u) => !u.insufficientFunds);
  if (round % 2 === 0 && amateurUsers.length >= 2) {
    const numSlices = Math.max(1, Math.ceil(amateurUsers.length / QUEUE_BATCH_SIZE));
    const sliceIdx = Math.floor(round / 2) % numSlices;
    const start = sliceIdx * QUEUE_BATCH_SIZE;
    const slice = amateurUsers.slice(start, start + QUEUE_BATCH_SIZE);
    if (slice.length >= 2 && runner.status !== 'STOPPING' && runner.status !== 'STOPPED') {
      await runTierQueueBatch(runner, slice, 'AMATEUR');
    }
  }

  return [];
}

export async function runMatchmakingGameplayScenario(runner, playerA, playerB) {
  return runMatchmakingWave(runner, [playerA, playerB], 0);
}

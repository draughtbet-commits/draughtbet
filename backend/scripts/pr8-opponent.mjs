// The second client for the PR8 screen drive: P2 (BLACK), over a raw socket.
//
//   node scripts/pr8-opponent.mjs <fixture.json> [command]
//
// It signs in as the seeded BLACK player and keeps a socket open so the drive
// test can force a genuine version conflict: the app sits on a board at
// version N, this client moves first to take the server to N+1, and the app's
// next submit carries the stale N and is refused with stale_state — which is
// the whole point of PR8's gate.
//
// Commands (all optional, defaults to holding the socket open):
//   hold      connect, join, and idle (default)
//   move      connect, join, play the first legal move, print the new version
//   join      connect and join, print the snapshot, then exit
//   status    report whether the seeded turn is still alive, then exit
//
// It prints `PR8_OPPONENT version=<n>` on the line the drive test greps for, so
// the test knows the server has advanced and the app's cached version is stale.
import fs from 'node:fs';
import { io as createSocketClient } from 'socket.io-client';
import { getLegalMoves, COLOR_WHITE, COLOR_BLACK } from '../src/modules/engine/index.js';

const fixturePath = process.argv[2] || '/tmp/opencode/record/pr8-fixture.json';
const command = process.argv[3] || 'hold';
const API = process.env.DRIVE_API || 'http://127.0.0.1:3100/api/v1';
const SOCKET_URL = API.replace(/\/api\/v1\/?$/, '');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Plays as whichever side the fixture holds. The default is P2/BLACK, which is
// the opponent the resync step needs; DRIVE_SIDE=WHITE signs in as P1 instead,
// which lets the opening move be replayed without a Flutter build in the loop.
const SIDE = (process.env.DRIVE_SIDE || 'BLACK').toUpperCase();
const FIXTURE_USER = SIDE === 'WHITE' ? fixture.p1 : fixture.p2;
const FIXTURE_COLOR = SIDE === 'WHITE' ? COLOR_WHITE : COLOR_BLACK;

const login = async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: FIXTURE_USER.email,
      password: FIXTURE_USER.password
    })
  });
  const body = await res.json().catch(() => ({}));
  const token = body.data?.accessToken ?? body.accessToken;
  if (!token) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return token;
};

const once = (client, event, timeout = 6000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const main = async () => {
  const token = await login();
  const client = createSocketClient(SOCKET_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false
  });

  await once(client, 'connect');
  const joined = once(client, 'match.state');
  client.emit('match.join', { matchId: fixture.matchId });
  const snapshot = await joined;
  console.log(
    `PR8_OPPONENT joined match=${fixture.matchId} version=${snapshot.version} turn=${snapshot.currentTurn}`
  );

  if (command === 'join') {
    client.close();
    return;
  }

  if (command === 'status') {
    // The seed writes the turn deadline, and the server's CAS guard refuses any
    // move once it lapses with TURN_EXPIRED — which the app reports as
    // STATE RESYNC, the same thing the resync step is trying to prove. Reading
    // the authoritative clock here lets the drive tell a real version-gate
    // rejection from a seed that went stale during the build. serverNowMs is
    // used rather than the local clock so the answer comes from the server.
    const deadlineAt = Number(snapshot.deadlineAt ?? 0);
    const serverNowMs = Number(snapshot.serverNowMs ?? Date.now());
    const turnExpired = deadlineAt > 0 && deadlineAt < serverNowMs;
    console.log(
      `PR8_OPPONENT status turnExpired=${turnExpired} ` +
        `remainingMs=${deadlineAt > 0 ? deadlineAt - serverNowMs : 'none'} ` +
        `reason=${turnExpired ? 'deadline lapsed, re-run the seed' : 'turn alive'}`
    );
    client.close();
    return;
  }

  if (command === 'move') {
    // The opponent is BLACK, so a legal move only exists once WHITE has moved.
    // Waiting for a non-zero legal list keeps this honest instead of guessing a
    // square, and the drive test always makes the app move first.
    //
    // The join snapshot already carries the authoritative board and the
    // server-computed legalMoves for the side to move, so it is used directly.
    // Re-requesting state instead is what used to break this: the resync step
    // parks game_state at the proxy so the *app* stays on a stale version, and
    // a re-poll that waits on game_state never receives a board. That timed out
    // as "no legal BLACK move appeared within 30s", which reads as a broken
    // engine or a dead socket when the real cause was a frame the drive
    // deliberately held back.
    const parseBoard = (raw) => {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : null;
    };

    const fromSnapshot = (s) => {
      const board = parseBoard(s?.board);
      if (!board) return null;
      // Prefer the server's own legal list for the side to move; fall back to
      // computing it so a snapshot without legalMoves still works.
      const legal =
        Array.isArray(s.legalMoves) && s.legalMoves.length > 0
          ? s.legalMoves
          : getLegalMoves(board, FIXTURE_COLOR);
      return legal.length > 0 ? legal[0] : null;
    };

    let move = fromSnapshot(snapshot);
    let source = 'join snapshot';
    if (move) {
      console.log(
        `PR8_OPPONENT found a legal ${FIXTURE_COLOR} move in the ${source}: ` +
          `${move.from}->${move.to} (as ${FIXTURE_COLOR})`,
      );
    }

    // Fallback only: re-request the snapshot and retry until the turn deadline.
    // The drive makes the app move first, so the join snapshot is occasionally
    // taken a beat before the app's move lands; this covers that window without
    // depending on any particular frame.
    const deadline = Date.now() + 30000;
    let polls = 0;
    while (!move && Date.now() < deadline) {
      const state = await new Promise((resolve) => {
        const settle = (payload) => resolve(payload);
        client.once('match.state', settle);
        client.once('game_state', settle);
        client.emit('match.state', { matchId: fixture.matchId });
        setTimeout(() => resolve(null), 2000);
      });
      polls += 1;
      if (state) {
        move = fromSnapshot(state);
        if (move) {
          console.log(
            `PR8_OPPONENT found a legal ${FIXTURE_COLOR} move on poll ${polls}: ` +
              `${move.from}->${move.to} (as ${FIXTURE_COLOR})`,
          );
        }
      }
      if (!move) await new Promise((r) => setTimeout(r, 500));
    }
    if (!move) {
      throw new Error(
        'no legal BLACK move found in the join snapshot or within 30s of polling ' +
          `(turn=${snapshot.currentTurn}, version=${snapshot.version})`,
      );
    }

    const clientMoveId = `pr8_opp_${Date.now()}`;
    // The server emits `move_rejected` (legacy) and `move.accepted`; there is no
    // `move.rejected` frame — that name only appears in comments. Waiting on the
    // accept alone therefore hangs until the timeout on every refusal and hides
    // the reason, so both are raced here and the rejection is surfaced verbatim.
    const settled = await new Promise((resolve) => {
      client.once('move.accepted', (p) => resolve({ ok: true, payload: p }));
      client.once('move_rejected', (p) => resolve({ ok: false, payload: p }));
      client.emit('move.submit', {
        matchId: fixture.matchId,
        clientMoveId,
        expectedStateVersion: Number(snapshot.version ?? fixture.version),
        from: move.from,
        path: move.path ?? [move.from, move.to],
      });
      setTimeout(() => resolve({ ok: false, payload: null }), 15000);
    });
    if (!settled.ok) {
      throw new Error(
        `server refused ${move.from}->${move.to} at version ` +
          `${snapshot.version}: ${JSON.stringify(settled.payload)}`,
      );
    }
    const result = settled.payload;
    // This is the signal the drive test waits for: the server has moved on, so
    // whatever version the app still holds is now stale. The "moved" prefix
    // keeps it distinct from the join line, which also reports a version.
    console.log(`PR8_OPPONENT moved version=${result.stateVersion} move=${move.from}->${move.to}`);

    // Stay connected after moving. Closing here dropped P2's presence, the
    // backend broadcast opponent_disconnected, and the app's disconnect overlay
    // then swallowed the stale tap this whole step exists to provoke — so the
    // step failed as "the stale move was not refused" while the real cause was a
    // presence that had gone away. Holding the socket open keeps the app on a
    // live opponent; the proxy SIGKILLs this child when the step is done.
    process.on('SIGTERM', () => {
      client.close();
      process.exit(0);
    });
    setInterval(() => {}, 1 << 30);
    return;
  }

  // hold: keep the socket open so the room subscription stays live.
  console.log('PR8_OPPONENT holding socket open');
  process.on('SIGTERM', () => {
    client.close();
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
};

main().catch((err) => {
  console.error(`opponent failed: ${err.message}`);
  process.exit(1);
});

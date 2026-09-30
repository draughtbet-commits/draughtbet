// A delaying proxy in front of the backend, used only by the PR8 screen drive.
//
//   node scripts/pr8-socket-proxy.mjs            # 3200 -> 3100
//
// The app points BACKEND_URL at this port, so both its REST calls and its
// Socket.IO connection arrive here and are relayed to the real backend. REST is
// passed straight through. WebSocket frames are inspected, and any frame whose
// text contains one of the held event names is parked in a queue until the drive
// test releases it.
//
// Why this exists: two PR8 screens can only be caught with a delayed frame.
// "Move submitted · waiting for server" exists only between the emit and the
// reply, and a stale state needs the opponent's game_state to arrive *after* the
// app has already submitted, so its cached version is behind. Blocking the
// socket instead would not do: the app sets syncState offline and refuses to
// move, so the board has to look healthy while its information is late. That is
// exactly the condition PR8's version gate exists for, so the delay is standing
// in for a slow link, not faking a server response.
//
// Control (HTTP, on this same port):
//   GET /__proxy/hold?events=game_state,match.state   park matching frames
//   GET /__proxy/release                               flush the queue
//   GET /__proxy/status                                queue depth and held names
//   GET /__proxy/opponent?command=hold                 start the opponent, return its pid
//   GET /__proxy/opponent?command=move                 play a move, return the new version
//
// It also serves the seed's fixture at /__fixture/pr8-fixture.json, because the
// drive test runs on the device and cannot read the host's filesystem.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const LISTEN = Number(process.env.PROXY_PORT || 3200);
const UPSTREAM_PORT = Number(process.env.PROXY_UPSTREAM || 3100);
const UPSTREAM_HOST = process.env.PROXY_UPSTREAM_HOST || '127.0.0.1';
const FIXTURE_PATH = process.env.DRIVE_FIXTURE || '/tmp/opencode/record/pr8-fixture.json';
const FIXTURE_ROUTE = '/__fixture/pr8-fixture.json';
const BACKEND_DIR = process.env.PROXY_BACKEND_DIR || '/home/mr-robot/draughtbet/backend';

// Two independent P2 sockets, because they have different jobs and different
// lifetimes.
//
//   hold — the persistent presence. Started for every step and left running so
//     the app always sees a connected opponent.
//   move — a one-shot client that makes a single legal move and exits.
//
// They are separate slots rather than one because the resync step needs both at
// once. Sharing a slot meant `command=move` killed the hold, and then the mover's
// own exit disconnected P2 for good: the backend broadcast opponent_disconnected,
// the app dropped opponentConnected, MatchScreen mounted the disconnect overlay,
// and the overlay swallowed the very tap the step exists to make. It surfaced as
// "the stale move was not refused" with no destinations ever offered, which
// points nowhere near the presence that was actually dropped.
let opponentHold = null;
const opponentMoves = new Map();

// Without this, stopping the proxy leaves P2 attached to the backend holding a
// presence open for a match the drive has finished with.
const killOpponent = () => {
  if (opponentHold) opponentHold.kill('SIGKILL');
  for (const child of opponentMoves.values()) child.kill('SIGKILL');
  opponentHold = null;
  opponentMoves.clear();
};
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, killOpponent);
}

// Frames whose text contains any of these are parked while holding is armed.
let heldEvents = [];
const queue = [];

// PROXY_VERBOSE=1 logs every frame in both directions. A held drive only ever
// shows the parked ones, so when a step fails for want of a frame that never
// arrived, this is what shows whether the app sent nothing, or sent something
// the server refused.
const verbose = process.env.PROXY_VERBOSE === '1';

// Socket.IO frames are `42["event",{...}]`; the payload is far too long to read
// inline, so name the event and keep the first few keys of the body.
const summarise = (text) => {
  const head = text.slice(0, 80).replace(/\n/g, ' ');
  const body = text.slice(80, 260).replace(/\n/g, ' ');
  return `${head} | ${body}${text.length > 260 ? '…' : ''}`;
};

const park = (payload) => {
  queue.push(payload);
  // ignore: avoid_print
  console.log(`[proxy] parked frame (${queue.length} held): ${payload.slice(0, 90)}`);
};

// The app's own move ids look like `move-<epoch>-<n>`; the opponent's are
// `pr8_opp_<epoch>`. Remembering the ids the app has sent lets a held run pass
// the app's own acceptance through while still parking the opponent's, which
// share an event name and are otherwise indistinguishable.
const appClientMoveIds = new Set();

// A held run needs the app's own move.accepted to land — it is what clears
// isMovePending, and inputEnabled requires !isMovePending, so parking it would
// stop the stale submit from ever being sent. Every other version-carrying frame
// is parked, including the opponent's move.accepted, which otherwise handed the
// app the new version and made its next submit legitimately current.
const shouldHold = (text) => {
  if (heldEvents.length === 0) return false;
  const upper = text.toUpperCase();
  if (!heldEvents.some((name) => upper.includes(name.toUpperCase()))) return false;
  for (const id of appClientMoveIds) {
    if (text.includes(id)) return false;
  }
  return true;
};

// Records the app's move ids as it sends them, so the matching acceptances are
// recognised above. Only ids minted by the app are counted; the opponent's
// `pr8_opp_` ids are ignored on purpose.
const noteAppSubmit = (text) => {
  for (const match of text.matchAll(/"clientMoveId":"(move-[^"]+)"/g)) {
    appClientMoveIds.add(match[1]);
  }
};

const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // The drive test runs on the device and cannot read the host's filesystem,
  // so the seed's fixture is served from here.
  if (url.pathname === FIXTURE_ROUTE) {
    try {
      const body = fs.readFileSync(FIXTURE_PATH);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // The opponent has to run on the host — it needs the repo and the fixture
  // file, and the drive test runs on the device — so the test asks for it here
  // instead of spawning it itself.
  if (url.pathname === '/__proxy/opponent') {
    const command = url.searchParams.get('command') || 'hold';
    // Kill any previous socket in *this* slot before starting another. Every
    // client that shares the same user id for one match is a single presence, so
    // an orphaned socket from an earlier run keeps competing with this one: when
    // it finally dies the backend broadcasts opponent_disconnected, the app drops
    // opponentConnected, MatchScreen mounts the disconnect overlay, and that
    // overlay swallows the next tap. The symptom lands in the UI as "the board
    // won't accept a move", which is nothing like its actual cause.
    //
    // Scoped to the slot so a one-shot `move` cannot tear down the persistent
    // `hold` — see the note on the two slots above.
    // A mover gets a slot per colour, so the two scripted plies of the resync
    // step can run back to back without the second one killing the first. Movers
    // hold their sockets open after moving, and a kill here would broadcast
    // opponent_disconnected — for the WHITE mover that is the *app's own* user
    // id, which would drop a presence the app is relying on and mount the
    // disconnect overlay over the very tap the step is trying to make.
    const side = (url.searchParams.get('side') || '').toUpperCase();
    const slot = command === 'move' ? `move:${side}` : 'hold';
    if (slot === 'hold' && opponentHold) {
      opponentHold.kill('SIGKILL');
      opponentHold = null;
    }
    if (opponentMoves.has(slot)) {
      opponentMoves.get(slot).kill('SIGKILL');
      opponentMoves.delete(slot);
    }
    const child = spawn(
      process.execPath,
      [path.join(BACKEND_DIR, 'scripts/pr8-opponent.mjs'), FIXTURE_PATH, command],
      {
        cwd: BACKEND_DIR,
        // The scheme matters: the opponent feeds DRIVE_API to fetch() and derives
        // the socket origin by stripping /api/v1, and a bare host:port is not a
        // parseable URL for either.
        //
        // `side` lets the script play the app's own colour. The resync step needs
        // the server one full move ahead of the app while the app still believes
        // it is WHITE's turn: only a non-app client playing WHITE can do that,
        // because once the app has been told it is WHITE's turn at v2, BLACK has
        // no legal move to advance the server any further.
        env: {
          ...process.env,
          DRIVE_API: `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/api/v1`,
          ...(url.searchParams.get('side')
            ? { DRIVE_SIDE: url.searchParams.get('side') }
            : {}),
        },
      }
    );
    if (slot === 'move') opponentMoves.set(slot, child);
    else opponentHold = child;
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });

    const moved = /moved version=(\d+)/;
    const statusLine = /status turnExpired=(\w+)\s+remainingMs=(\S+)\s+reason=(.*)/;
    const finish = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (command === 'status') {
      // Answers immediately: the drive calls this before it submits, to rule out
      // a lapsed turn, so it must not wait on a long-lived child.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(504, { error: 'opponent did not report a status', output: out.slice(-500) });
      }, 20000);

      child.stdout.on('data', (chunk) => {
        const match = statusLine.exec(chunk.toString());
        if (!match) return;
        clearTimeout(timer);
        finish(200, {
          turnExpired: match[1] === 'true',
          remainingMs: match[2],
          reason: match[3],
        });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!res.writableEnded) {
          finish(code === 0 ? 200 : 500, {
            error: `opponent exited ${code}`,
            output: out.slice(-500),
          });
        }
      });
      return;
    }

    if (command === 'hold') {
      // Long lived on purpose: it keeps the room subscription alive for the
      // whole recording, and the test never waits on it.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pid: child.pid }));
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(504, { error: 'opponent did not report a move', output: out.slice(-500) });
    }, 45000);

    child.stdout.on('data', (chunk) => {
      const match = moved.exec(chunk.toString());
      if (!match) return;
      clearTimeout(timer);
      finish(200, { version: Number(match[1]), output: out.slice(-500) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!res.writableEnded) {
        finish(code === 0 ? 200 : 500, { error: `opponent exited ${code}`, output: out.slice(-500) });
      }
    });
    return;
  }

  if (url.pathname.startsWith('/__proxy/')) {
    const action = url.pathname.replace('/__proxy/', '');
    // Control-plane requests are logged unconditionally, not just under
    // PROXY_VERBOSE. A held step silently failing to arm looks exactly like a
    // server that ignored a stale move, and there is no other evidence that the
    // request arrived.
    console.log(`[proxy:ctl] ${action}${url.search}`);
    if (action === 'hold') {
      heldEvents = (url.searchParams.get('events') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ holding: heldEvents }));
      return;
    }
    if (action === 'reset') {
      // A run that dies mid-hold would otherwise leave frames parked and the
      // next run would join to a board that never arrives.
      heldEvents = [];
      queue.length = 0;
      appClientMoveIds.clear();
      killOpponent();
      // ignore: avoid_print
      console.log('[proxy] reset');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reset: true }));
      return;
    }
    if (action === 'release') {
      const flushed = queue.splice(0, queue.length);
      for (const payload of flushed) {
        for (const client of sockets) {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        }
      }
      // ignore: avoid_print
      console.log(`[proxy] released ${flushed.length} frame(s)`);
      heldEvents = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ released: flushed.length }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ holding: heldEvents, queued: queue.length }));
    return;
  }

  // Everything else is ordinary REST, passed through untouched.
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  req.pipe(upstream);
});

// App-side sockets, so a release can flush parked frames to all of them.
const sockets = new Set();

const wss = new WebSocketServer({ noServer: true });

proxy.on('upgrade', (req, socket, head) => {
  // Accept the app's handshake first, then dial the backend and mirror. Doing it
  // in this order means the app gets its 101 without waiting on the upstream.
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);

    const upstream = new WebSocket(`ws://${UPSTREAM_HOST}:${UPSTREAM_PORT}${req.url}`, {
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }
    });

    // Frames travelling to the server are never held — only the app's view of
    // the world is delayed, so it can still submit while it is behind.
    ws.on('message', (data, isBinary) => {
      if (!isBinary) noteAppSubmit(data.toString());
      if (verbose && !isBinary) console.log(`[proxy:app->srv] ${summarise(data.toString())}`);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });

    upstream.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text !== null && shouldHold(text)) {
        park(text);
        return;
      }
      if (verbose && text !== null) console.log(`[proxy:srv->app] ${summarise(text)}`);
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
    });

    upstream.on('open', () => {
      // ignore: avoid_print
      console.log('[proxy] upstream socket open');
    });
    upstream.on('close', () => ws.close());
    upstream.on('error', (err) => {
      // ignore: avoid_print
      console.error(`[proxy] upstream error: ${err.message}`);
      ws.close();
    });

    ws.on('close', () => {
      sockets.delete(ws);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
    ws.on('error', () => sockets.delete(ws));
  });
});

proxy.listen(LISTEN, () => {
  // ignore: avoid_print
  console.log(`[proxy] ${LISTEN} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});

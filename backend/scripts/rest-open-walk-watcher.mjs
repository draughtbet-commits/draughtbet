import { io } from 'socket.io-client';

// Drives the open-match side of the walkthrough for p2arena against the
// REST contract (/api/v1/matches):
//   - creates the open match p2 can see (the seed app then joins it)
//   - once the seed's join funds the match, signals readiness on both
//     sides (seed via REST /ready, p2 via REST /ready) to start the game
//   - after RESIGN_AFTER_MS in the started game, resigns so seed wins
const BASE = process.env.BASE_URL || 'http://localhost:3000/api/v1';
const RESIGN_AFTER_MS = Number(process.env.RESIGN_AFTER_MS || 4000);

const P2_EMAIL = process.env.P2_EMAIL;
const P2_PASSWORD = process.env.P2_PASSWORD;
const SEED_EMAIL = process.env.SEED_EMAIL;
const SEED_PASSWORD = process.env.SEED_PASSWORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let matchId = null;
let socket = null;
let startedAt = 0;
let resigned = false;
let readyP2 = false;
let readySeed = false;
let seedToken = null;

async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fingerprintHash: 'rest-walk-watcher' }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  return (await res.json()).accessToken;
}

async function api(method, path, token, body, action) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (action) headers['Idempotency-Key'] = withAction(action);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return json;
}

const withAction = () => {
  const micros = Date.now() * 1000;
  const nonce = Math.floor(Math.random() * 0x7fffffff).toString(16);
  return `walk-${micros}-${nonce}`;
};

async function createOpenMatch(token) {
  const res = await api('POST', '/matches', token, {
    stakeMinor: '1000000',
    timeControlSeconds: 300,
    ruleset: 'CLASSIC',
    visibility: 'PUBLIC',
  }, 'walk-create');
  matchId = res.data.id;
  console.log('open match created', matchId);
  return matchId;
}

async function connect(p2Token, mid) {
  socket = io('http://localhost:3000', {
    auth: { token: p2Token },
    transports: ['websocket'],
  });
  socket.on('connect', () => {
    console.log('watcher connected', socket.id, 'match', mid);
    socket.emit('join_match', { matchId: mid });
  });
  socket.on('match.state', (d) => {
    const st = d && d.status;
    console.log('match.state', st, 'turn', d?.currentTurn ?? '');
    if (st === 'in_progress' && startedAt === 0) {
      startedAt = Date.now();
      console.log('MATCH IN_PROGRESS, clock started');
    }
  });
  socket.on('game.started', (d) => {
    if (startedAt === 0) startedAt = Date.now();
    console.log('game.started', d?.status ?? d?.stateVersion);
  });
  socket.on('connect_error', (e) => console.log('connect_error', e.message));
  socket.on('disconnect', () => console.log('watcher disconnected'));
}

async function watchMatch(p2Token) {
  for (;;) {
    let status;
    try {
      const snap = await api('GET', `/matches/${matchId}`, p2Token);
      status = snap.data && snap.data.status;
    } catch (err) {
      if (String(err.message).includes('429')) {
        console.log('rate limited, backing off 30s');
        await sleep(30000);
        continue;
      }
      console.log('watch error', err.message);
      await sleep(3000);
      continue;
    }
    if (status === 'FUNDED' || status === 'READY' || status === 'IN_PLAY') {
      console.log('match status now', status);
      if (status === 'IN_PLAY' && startedAt === 0) startedAt = Date.now();
      return 'joined';
    }
    if (status !== 'OPEN') {
      console.log('match no longer open (', status + '), recreating');
      return 'stale';
    }
    await sleep(3000);
  }
}

async function signalReadiness(p2Token, seedToken) {
  if (!readySeed) {
    await sleep(2000);
    const snap = await api('POST', `/matches/${matchId}/ready`, seedToken, {}, 'walk-ready-seed');
    readySeed = true;
    console.log('seed ready ->', snap.data.status);
  }
  if (!readyP2) {
    await sleep(500);
    const snap = await api('POST', `/matches/${matchId}/ready`, p2Token, {}, 'walk-ready-p2');
    readyP2 = true;
    console.log('p2 ready ->', snap.data.status);
  }
}

async function resignWhenExpired() {
  if (!socket || resigned) return;
  if (startedAt === 0) return;
  if (Date.now() - startedAt < RESIGN_AFTER_MS) return;
  resigned = true;
  console.log('EMIT resign');
  socket.emit('resign', { matchId });
}

async function waitForSettled(p2Token) {
  for (;;) {
    const snap = await api('GET', `/matches/${matchId}`, p2Token);
    const status = snap.data && snap.data.status;
    if (status === 'SETTLED' || status === 'COMPLETED') {
      console.log('MATCH SETTLED (status', status + ')');
      return;
    }
    await sleep(1000);
  }
}

async function seedLogin() {
  seedToken = await login(SEED_EMAIL, SEED_PASSWORD);
  console.log('seed logged in');
}

async function main() {
  const p2Token = await login(P2_EMAIL, P2_PASSWORD);
  console.log('p2 logged in');
  await seedLogin();

  for (;;) {
    await createOpenMatch(p2Token);
    await connect(p2Token, matchId);
    const outcome = await watchMatch(p2Token);
    if (outcome === 'joined') break;
    socket?.disconnect();
    await sleep(1000);
  }

  await signalReadiness(p2Token, seedToken);

  await new Promise((r) => setTimeout(r, RESIGN_AFTER_MS + 4000));
  resignWhenExpired();
  await waitForSettled(p2Token);
  process.exit(0);
}

main().catch((e) => {
  console.error('watcher fatal', e);
  process.exit(1);
});
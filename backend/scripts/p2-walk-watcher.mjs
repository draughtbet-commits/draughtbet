import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Drives the DARK/WHITE-side of the lifecycle walkthrough for p2arena:
//  - discovers the match created from the accepted callout (env CALLOUT_ID)
//  - reads seed's readiness via `match.state` and emits `player.ready`
//  - once in_progress, waits RESIGN_AFTER_MS, then resigns (p2 loses, seed wins)
const CALLOUT_ID = process.env.CALLOUT_ID;
const RESIGN_AFTER_MS = Number(process.env.RESIGN_AFTER_MS || 4000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let matchId = null;
let socket = null;
let readyEmitted = false;
let resigned = false;
let gamesStartedAt = 0;
let token = null;

async function login() {
  const res = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.P2_EMAIL,
      password: process.env.P2_PASSWORD,
      fingerprintHash: 'walk-watcher',
    }),
  });
  if (!res.ok) throw new Error('login failed ' + res.status);
  token = (await res.json()).accessToken;
}

async function findMatch() {
  const callout = await prisma.callout.findUnique({
    where: { id: CALLOUT_ID },
    select: { id: true, status: true, challengerId: true },
  });
  if (!callout || callout.status !== 'ACCEPTED') return null;
  const match = await prisma.match.findFirst({
    where: {
      OR: [{ playerLightId: callout.challengerId }],
      status: { in: ['FUNDED', 'READY', 'IN_PLAY'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  return match?.id ?? null;
}

async function connect(mid) {
  matchId = mid;
  socket = io('http://localhost:3000', {
    auth: { token },
    transports: ['websocket'],
  });
  socket.on('connect', () => {
    console.log('watcher connected', socket.id, 'match', matchId);
    socket.emit('join_match', { matchId });
  });
  socket.on('match.state', (d) => {
    const st = d && d.status;
    const participants = (d && d.participants) || [];
    const p2 = participants.find((p) => String(p.userId) !== process.env.SEED_ID);
    const seed = participants.find((p) => String(p.userId) === process.env.SEED_ID);
    const seedReady = seed && seed.ready === true;
    const myReady = p2 && p2.ready === true;
    console.log(
      'match.state', st,
      'seedReady=' + seedReady,
      'p2Ready=' + myReady,
      'cur=' + (d && d.currentTurn) + '/' + (d && d.currentTurnUserId),
    );
    if (st === 'in_progress' && gamesStartedAt === 0) {
      gamesStartedAt = Date.now();
      console.log('MATCH IN_PROGRESS, clock started');
    }
    if (st !== 'in_progress' && !readyEmitted && seedReady && !myReady) {
      readyEmitted = true;
      const actionId = Date.now() + '-' + Math.floor(Math.random() * 1e9);
      console.log('EMIT player.ready');
      socket.emit('player.ready', { matchId, actionId });
    }
  });
  socket.on('game.started', () => {
    if (gamesStartedAt === 0) gamesStartedAt = Date.now();
  });
  socket.on('game_state', (d) => {
    console.log('game_state', d && d.status);
    if (d && d.status === 'in_progress' && gamesStartedAt === 0) {
      gamesStartedAt = Date.now();
    }
  });
  socket.on('connect_error', (e) => console.log('connect_error', e.message));
  socket.on('disconnect', () => console.log('watcher disconnected'));
}

async function resignWhenExpired() {
  if (!socket || resigned) return;
  if (gamesStartedAt === 0) return;
  if (Date.now() - gamesStartedAt < RESIGN_AFTER_MS) return;
  resigned = true;
  console.log('EMIT resign');
  socket.emit('resign', { matchId });
}

async function main() {
  await login();
  console.log('p2 watcher logged in');
  while (!matchId) {
    matchId = await findMatch();
    if (!matchId) {
      console.log('waiting for accepted callout -> match...');
      await sleep(1000);
    }
  }
  await connect(matchId);
  setInterval(resignWhenExpired, 1000);
  // keep-alive that also re-asserts readiness in case of reconnect blips
  setInterval(() => {
    if (socket && socket.connected && readyEmitted) {
      // no-op keepalive
    }
  }, 20000);
}

main().catch((e) => {
  console.error('watcher fatal', e);
  process.exit(1);
});
// Seeds a real, joinable, in-progress match for the PR8 screen drive.
//
//   PAYSTACK_API_BASE=http://127.0.0.1:4010 PORT=3100 \
//     node --env-file=.env scripts/seed-game-protocol-drive.mjs
//
// The two players register through the real HTTP API and are verified and
// funded the same way the withdrawal seed does it, so the app can sign in as
// either of them with a password. The geo binding is minted with the backend's
// own AuthService, because /auth/geo-locate needs a reverse geocode and this
// sandbox has no egress; the key, TTL and one-time semantics are the real ones.
//
// The match itself is a genuine match: stakes are debited through matchService
// and activated through the activation service, so the ledger, the outbox and
// the room subscription are all the shipping code. Only the board position is
// written straight into the Redis projection, because picking a position with a
// known legal move is the point and there is no endpoint for that.
//
// It writes the fixture to /tmp/opencode/record/pr8-fixture.json for the drive
// test to read, and prints the same thing.
import fs from 'node:fs';
import prisma from '../src/utils/db.js';
import redis from '../src/utils/redis.js';
import { AuthService } from '../src/modules/auth/service.js';
import { postDepositCredit } from '../src/services/ledgerService.js';
import { reconcileStakeLocks } from '../src/services/lockReconciliation.js';
import { debitStakes } from '../src/services/matchService.js';
import { finalizeMatchActivation, cancelPreplayMatch } from '../src/services/gameActivationService.js';
import {
  createInitialBoard,
  getLegalMoves,
  applyMove,
  COLOR_WHITE,
  COLOR_BLACK,
} from '../src/modules/engine/index.js';

const API = process.env.DRIVE_API || 'http://127.0.0.1:3100/api/v1';
const OUT = process.env.DRIVE_FIXTURE || '/tmp/opencode/record/pr8-fixture.json';

// Mirrors PRETTERMINAL_STATUSES in src/modules/match/service.js. Duplicated
// rather than imported because that module pulls in the whole match domain and
// this script only needs the list to find leftovers to clean up.
// Cancellable statuses only. This deliberately is NOT the full pre-terminal
// list: cancelPreplayMatch refuses IN_PLAY/ACTIVE because a live match's stake
// is wagered and must be settled, not refunded. The drive stands its own match
// up to IN_PLAY, so a broad pre-terminal query made every run request an
// impossible cancellation and leak the stake.
const CANCELLABLE_STATUSES = ['DRAFT', 'OPEN', 'FUNDED', 'READY'];
const LIVE_STATUSES = ['IN_PLAY', 'ACTIVE'];

const PASSWORD = 'Draughts@Dev2026';
const START_BALANCE = 5000000n; // 50,000.00, enough for the stake twice over
const STAKE = 100000n; // 1,000.00

const person = (role) => ({
  email: `drive.pr8.${role}@draughtsarena.net`,
  password: PASSWORD,
  firstName: 'Drive',
  lastName: role === 'p1' ? 'White' : 'Black',
  countryCode: 'NG',
  dateOfBirth: '1995-04-11',
});

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
};

const ensurePlayer = async (role) => {
  const p = person(role);
  const existing = await prisma.user.findUnique({ where: { email: p.email } });
  if (existing) {
    console.log(`seed: ${p.email} already exists (id=${existing.id})`);
    return existing;
  }
  const binding = await AuthService.createGeoBinding(p.countryCode);
  if (!binding) {
    throw new Error('could not mint a geo binding — Redis must be reachable');
  }
  const res = await call('POST', '/auth/register', { body: { ...p, geoBinding: binding } });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`register ${p.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`seed: registered ${p.email}`);
  return prisma.user.findUnique({ where: { email: p.email } });
};

const ensureVerifiedAndFunded = async (user) => {
  if (user.kycStatus !== 'VERIFIED') {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        kycStatus: 'VERIFIED',
        eligibility: {
          upsert: {
            create: { countryCode: 'NG', countryAllowed: true, ageVerified: true },
            update: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
          }
        }
      }
    });
    console.log(`seed: ${user.email} verified`);
  }
  const wallet = await prisma.wallet.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {}
  });
  // A Wallet row holds no balance in V2. The money is the sum of the
  // ledger entries on PLAYER_AVAILABLE, so that is what is read back.
  const available = async () => {
    const account = await prisma.ledgerAccount.findFirst({
      where: { userId: user.id, type: 'PLAYER_AVAILABLE' }
    });
    if (!account) return null;
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      select: { amountMinorUnits: true }
    });
    return entries.reduce((sum, e) => sum + BigInt(e.amountMinorUnits), 0n);
  };
  const reference = `pr8-drive-open-${user.id}`;
  const before = await available();
  // postDepositCredit is idempotent on the reference, so re-running tops up
  // rather than double-crediting an identical run.
  await postDepositCredit(prisma, {
    userId: user.id,
    amountMinorUnits: START_BALANCE,
    reference
  });
  const after = await available();
  if (after === before) {
    console.log(`seed: ${user.email} already funded at ${after}`);
  } else {
    console.log(`seed: ${user.email} funded ${before} -> ${after}`);
  }
  return after;
};

const main = async () => {
  const p1 = await ensurePlayer('p1');
  const p2 = await ensurePlayer('p2');
  await ensureVerifiedAndFunded(p1);
  await ensureVerifiedAndFunded(p2);

  // A player may hold only one pre-terminal match, enforced against the Match
  // table, so the previous run's match has to reach a terminal status before a
  // new one can be funded. Cancelling releases the reserved stake back to both
  // players through the real service, so the ledger stays balanced and the two
  // accounts stay reusable across runs.
  //
  // Only genuinely cancellable statuses belong here. cancelPreplayMatch refuses
  // IN_PLAY/ACTIVE on purpose (isLiveStatus): once a match is live its stake is
  // wagered and must be settled, never refunded. The drive deliberately stands
  // its own match up to IN_PLAY below, so querying pre-terminal broadly made
  // every run ask to cancel a match that could not be cancelled -- the old
  // fallback then forced the status and stranded the stake. Narrow the query and
  // report live leftovers instead of trying to refund them.
  const stale = await prisma.match.findMany({
    where: {
      status: { in: CANCELLABLE_STATUSES },
      OR: [{ playerLightId: p1.id }, { playerDarkId: p1.id }]
    },
    select: { id: true, status: true }
  });
  for (const row of stale) {
    console.log(`seed: cancelling leftover match ${row.id} (was ${row.status})`);
    try {
      await cancelPreplayMatch(row.id);
    } catch (err) {
      // Never force a match to CANCELLED here. The status write is not the
      // teardown: cancelling is what releases the locked stake and closes the
      // reservation, so writing the status alone strands the players' money in
      // PLAYER_LOCKED forever and leaves a RESERVED row pointing at a dead
      // match. Fail loudly and let the operator reconcile instead.
      throw new Error(
        `seed: cancelPreplayMatch(${row.id}) failed: ${err.message}. ` +
        'Refusing to force the status, because that would strand the reserved stake. ' +
        'Run the stake-lock reconciliation (STAKE_LOCK_RECONCILE_REPAIR=true) or fix the cause.'
      );
    }
    await redis.del(`match:${row.id}`);
  }

  // Live leftovers are expected, not a leak: an unfinished live match holds its
  // stake legitimately, which is exactly what the lock invariant describes. They
  // are reported so an accumulating pile is visible rather than silent.
  const liveLeftovers = await prisma.match.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      OR: [{ playerLightId: p1.id }, { playerDarkId: p1.id }]
    },
    select: { id: true, status: true }
  });
  if (liveLeftovers.length > 0) {
    console.log(
      `seed: ${liveLeftovers.length} live leftover match(es) still hold their stake ` +
        `(expected: their stake stays locked until settled): ` +
        liveLeftovers.map((m) => `${m.id.slice(0, 8)}=${m.status}`).join(', ')
    );
  }

  // Self-heal any lock drift a previous run left behind, so repeated seeding
  // converges instead of accumulating stranded stake.
  for (const user of [p1, p2]) {
    const reconciled = await reconcileStakeLocks(prisma, user.id);
    if (reconciled.staleRowsClosed > 0 || reconciled.repairedMinorUnits > 0n) {
      console.log(
        `seed: reconciled stake locks for ${user.email}: ` +
        `returned ${reconciled.repairedMinorUnits}, closed ${reconciled.staleRowsClosed} stale rows`
      );
    }
  }

  // A real match: stakes debited, then activated through the outbox.
  const match = await debitStakes(p1.id, p2.id, STAKE, 'PRO');
  const outbox = await prisma.gameOutbox.findFirst({ where: { matchId: match.id } });
  if (!outbox) throw new Error('no activation outbox row was created for the match');
  await finalizeMatchActivation(outbox.id);

  // finalizeMatchActivation stages the match deliberately: initializeGame with
  // `pending: true` writes ready_pending and no running clock, leaving the
  // durable row FUNDED because the real FUNDED -> IN_PLAY transition belongs to
  // the two-player ready gate in the socket layer (gameActivationService.js:82).
  // The drive has no ready-up UI, so it stands the match up here instead.
  //
  // This is not cosmetic. A durable FUNDED row against a live Redis projection is
  // a state no real code path produces, and the two disagree in a way that
  // breaks the drive: handleDisconnect reads the *database* status via
  // isPreStartMatch, sees FUNDED, and takes the pre-start disconnect branch, so
  // every opponent socket event arrives as opponent_disconnected with
  // preStart:true. The app then drops opponentConnected, MatchScreen mounts the
  // disconnect overlay, and the overlay swallows board taps — which reads as a
  // broken protocol rather than a mismatched seed.
  await prisma.match.update({
    where: { id: match.id },
    data: { status: 'IN_PLAY' },
  });
  const active = await prisma.match.findUnique({ where: { id: match.id } });
  console.log(`seed: match ${active.id} activated (status=${active.status})`);

  // The opening position, WHITE to move, version 0 — exactly what P2 asserts a
  // client receives on join.
  const board = createInitialBoard();
  const host = await prisma.match.findUnique({
    where: { id: match.id },
    select: { playerLightId: true, playerDarkId: true, timeControlSeconds: true }
  });
  const turnUserId = host.playerLightId;

  // The drive's own clock, not the host's. A host match is 60s per turn, which is
  // right for real play and useless here: the screen drive pays a Gradle build,
  // an install and a sign-in before the first tap, so the turn is already dead by
  // the time the app submits and the CAS guard refuses with TURN_EXPIRED. That
  // looks exactly like a protocol fault, so the drive would spend its time
  // debugging the wrong layer. An hour is longer than any step can take, and the
  // deadline is logged below so a stale clock is obvious at seed time.
  const DRIVE_TIME_CONTROL_SECONDS = Number(process.env.DRIVE_TIME_CONTROL_SECONDS || 3600);
  const deadlineAt = Date.now() + DRIVE_TIME_CONTROL_SECONDS * 1000;
  const hash = JSON.stringify([board, COLOR_WHITE]);
  await redis.hset(`match:${match.id}`, {
    board: JSON.stringify(board),
    currentTurn: COLOR_WHITE,
    currentTurnUserId: turnUserId,
    status: 'in_progress',
    winnerId: '',
    version: '0',
    moveCount: '0',
    positionCounts: JSON.stringify({ [hash]: 1 }),
    consecutiveKingMoves: '0',
    lastMoveTs: Date.now().toString(),
    deadlineAt: deadlineAt.toString(),
    timeControlSeconds: String(DRIVE_TIME_CONTROL_SECONDS)
  });
  console.log(
    `seed: board seeded, WHITE to move, version 0 ` +
      `(host tc was ${host.timeControlSeconds ?? 300}s, drive is ` +
      `${DRIVE_TIME_CONTROL_SECONDS}s, turn expires in ` +
      `${Math.round((deadlineAt - Date.now()) / 1000)}s)`
  );

  const legal = getLegalMoves(board, COLOR_WHITE);
  // Also report what BLACK can do after WHITE's opening move. The resync step
  // needs a legal reply for the opponent, and if the opening move strands it
  // then that step times out with "no legal BLACK move" — which looks like a
  // socket or engine fault and is neither. Checked here so it surfaces at seed
  // time instead, twenty minutes later, inside a Flutter build.
  const afterOpening = legal.length > 0 ? applyMove(board, legal[0]).newBoard : board;
  const blackReplies = getLegalMoves(afterOpening, COLOR_BLACK);
  console.log(
    `seed: ${legal.length} legal opening moves for WHITE; ` +
      `after ${legal.length > 0 ? `${legal[0].from}->${legal[0].to}` : 'n/a'}, ` +
      `BLACK has ${blackReplies.length} legal ` +
      `${blackReplies.length === 0 ? 'MOVES — state-resync will not be drivable' : 'replies'}`,
  );

  const fixture = {
    matchId: match.id,
    version: 0,
    turnUserId,
    p1: { id: p1.id, email: p1.email, password: PASSWORD, color: 'WHITE' },
    p2: { id: p2.id, email: p2.email, password: PASSWORD, color: 'BLACK' },
    stakeMinorUnits: STAKE.toString(),
    legalMoveCount: legal.length
  };
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2));
  console.log(`seed: wrote ${OUT}`);
  console.log(JSON.stringify(fixture, null, 2));

  await prisma.$disconnect();
  await redis.quit();
};

main().catch(async (err) => {
  console.error('seed failed:', err.message);
  await prisma.$disconnect().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(1);
});

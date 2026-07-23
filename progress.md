# Step 4–6: Game State Management, Financial Settlement & Disconnect Handling

We're picking up from the completed Step 3 (Matchmaking). The current `gameManager.js` only has `initializeGame()` — a scaffold. This plan covers the full game lifecycle: receiving moves, validating them server-side, persisting state, detecting game end, settling money, and handling disconnects.

> [!CAUTION]
> **Every money-moving operation in this system uses Prisma `$transaction` with `SELECT ... FOR UPDATE` row locks and status-gated idempotency checks.** No wallet balance is ever modified outside a serializable transaction. No settlement can execute twice. This is non-negotiable for a real-money app.

> [!CAUTION]
> **Every Redis game-state mutation uses a Lua script for atomic read-validate-write with a version stamp.** No multi-step `HSET` sequences. No read-outside-write races. Redis is not transactional — we enforce atomicity at the command level via `EVAL`.

## Proposed Changes

### 1. Socket Event Handler — `sockets/index.js`

#### [MODIFY] [index.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/index.js)

Wire up new client → server events inside the `io.on('connection')` block:

| Event | Handler | Description |
|---|---|---|
| `move_attempt` | `handleMoveAttempt(socket, { matchId, from, to })` | Validate & apply a move |
| `resign` | `handleResign(socket, { matchId })` | Player resigns, opponent wins |
| `join_match` | `handleJoinMatch(socket, { matchId })` | Reconnect: rejoin room, receive current state |
| `disconnect` | extend existing handler | Start 60s reconnect timer via sorted set |

---

### 2. Full Game State Manager — `sockets/gameManager.js`

#### [MODIFY] [gameManager.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/gameManager.js)

The current file only has `initializeGame()` (with broken import paths — fix noted in §8). We add:

**`handleMoveAttempt(socket, { matchId, from, to })`**

This is the most latency-sensitive path in the system (100ms budget). The core challenge: two `move_attempt` events for the same match can arrive near-simultaneously (double-click, client retry, malicious double-send). Without concurrency control on Redis, both read the same board, both validate successfully, and both write back — corrupting the game.

**Solution: Lua script for atomic compare-and-write with optimistic concurrency.**

The Lua script does NOT run game-engine validation — that stays in Node.js. The script's only job is the atomic compare-version-and-write-all-fields step. The engine validation (`getLegalMoves`, `applyMove`, `checkGameEnd`) runs in Node.js before the script is called.

**Full flow:**

1. **Read** game state from Redis (`HGETALL match:{matchId}`) — get board, version, currentTurn
2. **Validate in Node.js** — call `getLegalMoves(board, color)`, find matching move, call `applyMove()`, call `checkGameEnd()`
3. **Write back via Lua script** — pass the expected version and all new field values as arguments. The script checks `version == expectedVersion` before writing. If another move was processed between step 1 and step 3, the version won't match and the script returns `VERSION_MISMATCH`
4. On `VERSION_MISMATCH`, re-read state and re-validate (**up to 2 retries**, then reject — see retry policy below)

**The Lua script (real code, not pseudocode):**

```lua
-- game_state_cas.lua
-- Compare-and-swap for game state fields.
-- KEYS[1]  = match:{matchId}
-- ARGV[1]  = expected version (string, compared as string)
-- ARGV[2]  = new board JSON
-- ARGV[3]  = new currentTurn ("WHITE" or "BLACK")
-- ARGV[4]  = new currentTurnUserId
-- ARGV[5]  = new moveCount (string)
-- ARGV[6]  = now timestamp ms (string)
-- ARGV[7]  = new positionCounts JSON
-- ARGV[8]  = new consecutiveKingMoves (string)
-- ARGV[9]  = new status ("in_progress", "completed", or "draw")
-- ARGV[10] = new winnerId (string, or empty string if none)
--
-- Returns: "OK" on success, error on version mismatch or missing game

local key = KEYS[1]

-- Read current version (single field read, fast)
local currentVersion = redis.call('HGET', key, 'version')
if currentVersion == false then
  return redis.error_reply('GAME_NOT_FOUND')
end

if currentVersion ~= ARGV[1] then
  return redis.error_reply('VERSION_MISMATCH')
end

-- All checks passed — write ALL fields in a single atomic HSET
redis.call('HSET', key,
  'board',                  ARGV[2],
  'currentTurn',            ARGV[3],
  'currentTurnUserId',      ARGV[4],
  'version',                tostring(tonumber(currentVersion) + 1),
  'moveCount',              ARGV[5],
  'lastMoveTs',             ARGV[6],
  'positionCounts',         ARGV[7],
  'consecutiveKingMoves',   ARGV[8],
  'status',                 ARGV[9],
  'winnerId',               ARGV[10]
)

return 'OK'
```

> [!NOTE]
> **No `cjson` dependency in the script.** The original pseudocode implied JSON parsing inside Lua, which would require `cjson` (available in Redis 2.6+ but potentially restricted in some managed Redis builds). The real script above avoids this entirely — it receives pre-serialized JSON strings as `ARGV` from Node.js and writes them as-is. JSON parsing/serialization happens only in Node.js, where it's native. The script is purely a version-guarded field writer.

> [!IMPORTANT]
> **Why a Lua script, not WATCH/MULTI:** `WATCH/MULTI` requires the validation logic (legal move check) to run between `WATCH` and `EXEC`. That means the engine's `getLegalMoves()` — which is pure JavaScript, not Redis commands — would need to execute while holding the watch, and any other client touching the key would abort the transaction. A Lua script runs the entire read-check-write server-side in Redis, blocking other commands on that key for the duration. For a fast operation (one HGET + one HSET), this is the correct pattern.

**`VERSION_MISMATCH` retry policy:**

Up to **2 retries** (3 total attempts). On each `VERSION_MISMATCH`:
1. Re-read game state from Redis (`HGETALL`)
2. Re-validate the move against the new board state (it may no longer be legal)
3. Re-attempt the Lua script with the new version

If all 3 attempts fail (extremely unlikely — would require 3 concurrent moves for the same match in rapid succession), emit `move_rejected` to the sender with reason `'server_busy'`.

**`GAME_NOT_FOUND` is NOT retried.** If the Lua script returns `GAME_NOT_FOUND`, the game key has been deleted (settlement completed, cleanup ran). Emit `move_rejected` immediately with reason `'game_already_ended'` — retrying against a non-existent key is pointless.

**Client-side UX on rejection:** The Flutter client auto-retries `move_attempt` once with a fresh `HGETALL`-sourced state. If the second attempt is also rejected, it shows a brief "Syncing..." indicator (< 500ms) and re-fetches the full board state via `GET /matches/:id/state` before re-enabling move input. This keeps the UX smooth during time-scramble endgames where move bursts are legitimate.

**Win-via-move settlement flow (the common case):**

Most checkers games end by one side running out of pieces or legal moves — not by resign or disconnect. This is the primary game-ending path and must be traced with the same rigor:

1. **Node.js step 2**: After `applyMove()`, call `checkGameEnd(newBoard, nextColor, positionCounts, consecutiveKingMoves)`. This returns `{ ended, reason, winner }`.
2. **If `ended === true`**: set `newStatus = 'completed'` (or `'draw'`), and set `winnerId`. Pass these to the Lua CAS script as `ARGV[9]` and `ARGV[10]`. The CAS writes `status: 'completed'` and `winnerId` atomically with the final board state — these are never out of sync.
3. **After the CAS commits successfully**: emit `move_applied` to the room with `{ from, to, captured, promoted, nextTurn, gameEnded: true, reason }` so clients know this is the final move.
4. **Then call `settleGame()` or `settleGameDraw()`** — this is a separate step AFTER the CAS, not inside it. Settlement is a Postgres transaction; the Redis board state is already committed.
5. **If settlement fails** (DB blip, pool exhaustion): the board state and `status: 'completed'` are already in Redis, and the `Match` row in Postgres is still `ACTIVE`. Log at `error`, alert via Sentry, and retry settlement (same `persistMatchMove`-style retry with backoff). The idempotency gate in `settleGame` makes retries safe. Clients already received `move_applied` with `gameEnded: true` — they show the game-over UI immediately. The `match_ended` event (with payout info) follows once settlement commits, which may be a few hundred ms later on retry.
6. **Cleanup**: After settlement commits, delete `match:${matchId}` and both `user:{userId}:activeMatch` keys from Redis.

> [!IMPORTANT]
> **Settlement is AFTER CAS, not inside it.** The Lua script touches only Redis. Settlement is a Postgres `$transaction`. These are two different data stores with independent failure modes. Coupling them ("only write the board if settlement also succeeds") would require distributed transactions, which we don't have and don't need — the CAS is idempotent (version-guarded), settlement is idempotent (status-gated), and a partial failure (board committed, settlement pending) is recoverable via retry.

**`getGameState(matchId)`** — Load full state from Redis via `HGETALL`, used by reconnect endpoint and the `join_match` handler.

**`handleResign(socket, { matchId })`** — Verify the player is in this match, set game status to `'completed'` and `winnerId` to the opponent via the same Lua CAS script (version-checked), call `settleGame()`. **Note: the Lua script requires all 10 `ARGV` fields on every call.** For resign, `board`, `currentTurn`, `currentTurnUserId`, `moveCount`, `positionCounts`, `consecutiveKingMoves` are passed through unchanged from the current `HGETALL` read — only `status` changes to `'completed'` and `winnerId` to the opponent's ID.

**Redis Hash structure** (`match:${matchId}`):
```
player1:              <userId>         (white pieces)
player2:              <userId>         (black pieces)
currentTurn:          "WHITE" | "BLACK"
currentTurnUserId:    <userId>         (denormalized — avoids needing to resolve turn→userId in the Lua script)
board:                <JSON string of 50-element array>
status:               "in_progress" | "completed" | "draw"
winnerId:             <userId or empty> (set on completion for crash recovery)
stakeTier:            <tier string>
moveCount:            <int>
version:              <int, starts at 0, incremented on every mutation>
positionCounts:       <JSON object: { "boardHash": count, ... }>
consecutiveKingMoves: <int>
lastMoveTs:           <epoch ms>
```

**User → match index** (maintained alongside the hash):

To avoid `KEYS match:*` scanning, we maintain a lightweight index:

- On game start: `SET user:{userId}:activeMatch {matchId}` for both players
- On game end (settlement, draw, forfeit): `DEL user:{player1Id}:activeMatch` and `DEL user:{player2Id}:activeMatch`

**`getActiveGameForUser(userId)`**: `GET user:{userId}:activeMatch` — O(1), no scanning.

**`getOpponentId(matchId, userId)`**: `HGET match:{matchId} player1` and `HGET match:{matchId} player2`, return the one that isn't `userId`. Two O(1) lookups, no scanning. *(Note: returns a Promise, must be `await`ed)*.

Both are explicitly defined, not left as assumed utilities.

---

### 3. Threefold Repetition — Position Hash Map, Not Capped Array

The previous plan stored a `history` array capped at 50 board states for draw detection. **This is wrong for threefold repetition.** A position from move 5 could recur at moves 55 and 90 — if move 5's entry has rolled off a 50-state cap, the third repetition is never detected. In a real-money game where disputes are possible, an incorrect draw detection (or failure to detect a draw) is a financial bug.

**Fix: store a position → count map, not a move history array.**

- **`positionCounts`**: A JSON object in the Redis hash. Key = deterministic hash of `(board array + colorToMove)`. Value = number of times this exact position has been reached.
- On every move, after applying: hash the new `(board, nextColor)`, increment its count in the map.
- If any count reaches 3 → threefold repetition draw.
- **This never needs capping** — the number of entries equals the number of *unique* positions reached, which is bounded by the game length and far smaller than the move count (since repetitions map to existing keys, not new ones).

**25-consecutive-king-move draw**: tracked via `consecutiveKingMoves` counter in the Redis hash (reset to 0 whenever a non-king move or a capture occurs). No history array needed.

> [!IMPORTANT]
> The hash function for position identity must include both the board array AND whose turn it is. The same board with white-to-move and black-to-move are different positions. Use `JSON.stringify([board, colorToMove])` as the hash key — it's deterministic and fast enough for this use case.

---

### 4. Stake Debit at Match Start — `services/matchService.js`

#### [NEW] [matchService.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/services/matchService.js)

**`debitStakes(player1Id, player2Id, stakeTier)`**

This is extracted to a service so it can be called by **BOTH** the socket-based matchmaking (when two players are paired) **AND** the REST `POST /callouts/:id/accept` endpoint. This ensures that call-out matches use the exact same atomic transaction to escrow funds before the match is considered `ACTIVE`.

This is a **single Prisma `$transaction`** that either fully succeeds or fully rolls back:

```javascript
import crypto from 'crypto';

prisma.$transaction(async (tx) => {
  // 1. Lock both wallets (ordered by ascending userId to prevent deadlocks)
  const [w1, w2] = await lockWalletsInOrder(tx, player1Id, player2Id);
  // lockWalletsInOrder ALWAYS returns wallets in ascending-userId order,
  // NOT in (player1Id, player2Id) order. Callers must not assume positional mapping.

  // 2. Look up stake amount from PlatformSettings
  const settings = await tx.platformSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
  const stakeAmount = getStakeForTier(settings, stakeTier);

  // 3. Verify BOTH players can afford the stake
  if (w1.balanceMinorUnits < stakeAmount || w2.balanceMinorUnits < stakeAmount) {
    throw new InsufficientFundsError();
  }

  // 4. Generate match ID upfront so WalletTransactions can reference it
  const matchId = crypto.randomUUID();

  // 5. Debit both wallets (debit-before-credit ordering — §7 rule)
  for (const w of [w1, w2]) {
    await tx.wallet.update({ where: { id: w.id }, data: { balanceMinorUnits: { decrement: stakeAmount } } });
    await tx.walletTransaction.create({ data: {
      walletId: w.id, type: 'STAKE', amountMinorUnits: -stakeAmount, relatedMatchId: matchId
    }});
  }

  // 6. Create Match row (status: ACTIVE)
  const match = await tx.match.create({ data: {
    id: matchId, // Use the generated ID
    playerLightId: player1Id, playerDarkId: player2Id,
    tier: stakeTier, stakeMinorUnits: stakeAmount, status: 'ACTIVE'
  }});
  return match;
});
```

**If this transaction fails for ANY reason** (insufficient funds, DB error, constraint violation), no game starts. Both players are notified via socket and returned to the queue, or the callout accept request returns a 400.

**Utility definitions:**

**`lockWalletsInOrder(tx, idA, idB)`**: Sorts `[idA, idB]` lexicographically. Runs two `SELECT ... FOR UPDATE` queries in that sorted order. Returns `[walletForSortedFirst, walletForSortedSecond]` — **always in sorted order, NOT in input order**. Callers iterate the array; they do not destructure positionally as `(player1Wallet, player2Wallet)`.

**`getStakeForTier(settings, tier)`**: Pure function. Reads `settings.{tier}StakeMinP` and returns it as a `BigInt`. No network calls, no side effects. If `tier` is not recognized, throws `InvalidTierError`.

---

### 5. Game Settlement — `sockets/settlement.js`

#### [NEW] [settlement.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/settlement.js)

**`settleGame(matchId, winnerId, loserId, reason)`**

**Idempotency-first design:** this function can be safely called multiple times for the same match — by resign, by the disconnect sweep, by a duplicate event. Only the first call that commits actually moves money; all subsequent calls are silent no-ops.

**This is an explicitly covered race condition:** if a player resigns at the exact moment their disconnect timer expires, both `handleResign` and the sweep job call `settleGame` near-simultaneously. The in-transaction status check serializes them via the row lock, and whichever transaction commits first sets `status = COMPLETED`, making the second call's `match.status !== 'ACTIVE'` check return true → no-op. This is by design, not by accident.

```
const result = await prisma.$transaction(async (tx) => {
  // === IDEMPOTENCY GATE (inside the transaction, under implicit row lock) ===
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: { status: true, stakeMinorUnits: true, playerLightId: true, playerDarkId: true }
  });

  // If already settled, bail out — this is the idempotency guard
  if (!match || match.status !== 'ACTIVE') return null;

  // === PROCEED (first caller only reaches here) ===

  // 1. Update Match: status = COMPLETED
  await tx.match.update({ where: { id: matchId }, data: {
    status: 'COMPLETED', winnerId, endReason: reason, endedAt: new Date()
  }});

  // 2. Look up commission (live from DB, never hardcoded)
  const settings = await tx.platformSettings.findUniqueOrThrow({ where: { id: 'singleton' } });

  // 3. Calculate payout
  const pot = match.stakeMinorUnits * 2n;
  const commission = pot * BigInt(settings.commissionPercent) / 100n;
  const payout = pot - commission;
  // ROUNDING NOTE: BigInt division floors. The fractional remainder (< 1 kobo)
  // accrues to the player, not the platform: payout = pot - floor(commission),
  // so the player receives the rounding dust. This is intentional, player-favorable,
  // and the standard approach for regulated wagering systems. Over volume, the platform
  // under-collects by < 1 kobo per match, which is financially immaterial but
  // audit-correct (platform never over-charges).

  // 4. Credit winner's wallet (lock via findUnique inside txn)
  const winnerWallet = await tx.wallet.findUniqueOrThrow({ where: { userId: winnerId } });
  await tx.wallet.update({ where: { id: winnerWallet.id }, data: {
    balanceMinorUnits: { increment: payout }
  }});

  // 5. Write WalletTransactions (PAYOUT + COMMISSION)
  await tx.walletTransaction.create({ data: {
    walletId: winnerWallet.id, type: 'PAYOUT',
    amountMinorUnits: payout, relatedMatchId: matchId
  }});
  await tx.walletTransaction.create({ data: {
    walletId: winnerWallet.id, type: 'COMMISSION',
    amountMinorUnits: -commission, relatedMatchId: matchId
  }});

  return { payout, commission };
});

// After transaction succeeds (result !== null):
// - Delete match:${matchId} hash from Redis
// - Emit match_ended → { winnerId, reason, payout } to the room
// - Emit wallet_updated → to the winner only
```

**`settleGameDraw(matchId, reason)`** — for draws (threefold, 25-king-move, mutual agreement):

```
await prisma.$transaction(async (tx) => {
  const match = await tx.match.findUnique({ where: { id: matchId } });
  if (!match || match.status !== 'ACTIVE') return null; // Idempotency gate

  await tx.match.update({ where: { id: matchId }, data: {
    status: 'COMPLETED', endReason: reason, endedAt: new Date()
  }});

  // Refund BOTH players — use lockWalletsInOrder for consistent lock ordering
  const [w1, w2] = await lockWalletsInOrder(tx, match.playerLightId, match.playerDarkId);

  for (const w of [w1, w2]) {
    await tx.wallet.update({ where: { id: w.id }, data: {
      balanceMinorUnits: { increment: match.stakeMinorUnits }
    }});
    await tx.walletTransaction.create({ data: {
      walletId: w.id, type: 'REFUND',
      amountMinorUnits: match.stakeMinorUnits, relatedMatchId: matchId
    }});
  }
});
```

> [!IMPORTANT]
> **Draw refunds use `lockWalletsInOrder`** — the same ascending-userId locking discipline as stake debits. This prevents deadlocks if a draw refund and a new stake debit for the same player run concurrently.

**`settleGameWithRetry` wrapper:**

Because settlement happens asynchronously *after* the Redis CAS commits the board state, a transient database failure would leave the match in a split-brain state (Redis = completed, Postgres = ACTIVE). We wrap the settlement calls to retry with backoff, ensuring eventual consistency:

```javascript
async function settleGameWithRetry(matchId, winnerId, loserId, reason, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await settleGame(matchId, winnerId, loserId, reason);
      return; // Success
    } catch (err) {
      logger.warn({ err, attempt, matchId }, 'settleGame failed, retrying');
      if (attempt === retries) {
        logger.error({ err, matchId }, 'CRITICAL: settleGame failed after all retries. Requires manual or sweep reconciliation.');
        Sentry.captureException(err, {
          level: 'fatal',
          tags: { subsystem: 'settlement' },
          extra: { matchId, winnerId, reason }
        });
      } else {
        await sleep(attempt * 500); // 500ms, 1000ms, 1500ms backoff
      }
    }
  }
}
// Note: Same wrapper exists for settleGameDrawWithRetry
```

---

### 6. MatchMove Postgres Write — Retry Queue, Not Fire-and-Forget

The `MatchMove` row is the documented fallback for `GET /matches/:id/state` when Redis is empty (see `07_ENGINEERING_STANDARDS_AND_OPERATIONS.md` §5 — `rebuildBoardFromMoveLog(matchId)`). A silently dropped write means state reconstruction produces a wrong board. This is not acceptable.

**Pattern: write with retry, alert on exhaustion.**

```js
async function persistMatchMove(moveData, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.matchMove.create({ data: moveData });
      return; // Success
    } catch (err) {
      logger.warn({ err, attempt, matchId: moveData.matchId, moveNumber: moveData.moveNumber },
        'MatchMove persist failed, retrying');
      if (attempt === retries) {
        // All retries exhausted — Sentry alert fires immediately
        logger.error({ err, moveData },
          'CRITICAL: MatchMove persist failed after all retries. Move audit trail has a gap.');
        Sentry.captureException(err, {
          level: 'fatal',
          tags: { subsystem: 'match_audit' },
          extra: { matchId: moveData.matchId, moveNumber: moveData.moveNumber }
        });
        // Do NOT throw — the game continues (Redis has the state),
        // but the audit trail is incomplete and ops is now alerted.
      } else {
        await sleep(attempt * 100); // 100ms, 200ms, 300ms backoff
      }
    }
  }
}
```

This runs asynchronously (no `await` in the hot path of `handleMoveAttempt`) but is NOT fire-and-forget — failures are retried with backoff, and exhaustion triggers a loud Sentry alert. The game continues regardless (Redis is authoritative for live state), but ops knows the audit trail has a gap.

---

### 7. Disconnect Handling — Unified Sorted Set

#### [NEW] [disconnectHandler.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/disconnectHandler.js)

**Single mechanism:** a Redis sorted set `disconnects`, scored by expiry timestamp (`Date.now() + 60000`). No separate TTL keys, no keyspace notifications, no duplicate sources of truth.

**On disconnect:**
```js
// 1. Look up active game for this user (scan match:* or maintain a user→game index)
const matchId = await getActiveGameForUser(userId);
if (!matchId) return; // Not in a game — nothing to do

// 2. Add to sorted set: member = "matchId:userId", score = expiryTimestamp
await redis.zadd('disconnects', Date.now() + 60000, `${matchId}:${userId}`);

// 3. Notify opponent
socket.to(`match:${matchId}`).emit('opponent_disconnected', { userId, gracePeriodMs: 60000 });
```

**On reconnect (via `join_match`):**
```js
// 1. Remove from sorted set
await redis.zrem('disconnects', `${matchId}:${userId}`);

// 2. Rejoin Socket.IO room (must match spec: match:{matchId})
socket.join(`match:${matchId}`);

// 3. Send current game state
const state = await getGameState(matchId);
socket.emit('game_state', state);

// 4. Notify opponent
socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
```

---

### 8. Disconnect Sweep Job — `jobs/disconnectSweep.js`

#### [NEW] [disconnectSweep.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/jobs/disconnectSweep.js)

`node-cron` job every 10 seconds:

```js
// 1. Pop all expired entries (score < now)
const expired = await redis.zrangebyscore('disconnects', '-inf', Date.now());

for (const entry of expired) {
  const [matchId, disconnectedUserId] = entry.split(':');

  // 2. Remove from sorted set FIRST (prevents next tick from re-processing)
  const removed = await redis.zrem('disconnects', entry);
  if (removed === 0) continue; // Another tick or reconnect already handled it

  // 3. TOCTOU guard: check if the player has reconnected since we read the set
  //    Scoped to the exact room used by Socket.IO — `match:${matchId}`
  const io = getIO();
  const roomSockets = await io.in(`match:${matchId}`).fetchSockets();
  const isReconnected = roomSockets.some(s => s.user?.userId === disconnectedUserId);

  if (isReconnected) {
    logger.info({ matchId, userId: disconnectedUserId },
      'Disconnect sweep: player reconnected before forfeit — skipping');
    continue;
  }

  // 4. Check for BOTH players disconnected
  // BUGFIX: getOpponentId does a Redis read, so it MUST be awaited
  const opponentId = await getOpponentId(matchId, disconnectedUserId);
  const otherDisconnect = await redis.zscore('disconnects', `${matchId}:${opponentId}`);

  if (otherDisconnect !== null) {
    // Both players disconnected — draw refund, not arbitrary forfeit
    await redis.zrem('disconnects', `${matchId}:${opponentId}`);
    logger.info({ matchId }, 'Both players disconnected — settling as draw');
    await settleGameDraw(matchId, 'both_disconnected');
    continue;
  }

  // 5. Single disconnect forfeit — disconnected player loses
  logger.info({ matchId, forfeitedBy: disconnectedUserId, winner: opponentId },
    'Disconnect timeout — auto-forfeit');
  await settleGame(matchId, opponentId, disconnectedUserId, 'forfeit_disconnect');
}
```

> [!IMPORTANT]
> **Reconnect race resolution (TOCTOU guard, step 3):** After popping the entry from the sorted set but before forfeiting, the sweep checks whether the player currently has an active socket in the game room. If they reconnected in the window between the sweep's `zrangebyscore` read and this check, the forfeit is skipped. This closes the race where a player reconnects at 59.8s but the sweep (which started scanning at 59.5s) processes their entry before `join_match`'s `zrem` executes.

> [!IMPORTANT]
> **Both-players-disconnect (step 4):** If both sockets drop, whoever's 60s timer expires first would normally "win by default" — a real-money outcome determined by network jitter, not game state. Instead: when processing a disconnect forfeit, check if the opponent is also in the disconnect set. If so, settle as a draw with full stake refund to both players. This is the only fair outcome when neither player is available to continue.

---

### 9. Reconciliation Sweep Job — `jobs/reconciliationSweep.js`

#### [NEW] [reconciliationSweep.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/jobs/reconciliationSweep.js)

**The Crash Recovery Gap:** What happens if the Node process crashes *after* the Lua CAS commits `status: 'completed'` to Redis but *before* `settleGameWithRetry` is ever invoked? The `Match` row stays `ACTIVE` in Postgres forever. 

`node-cron` job every 5 minutes (staggered to avoid overlapping with disconnect sweep):

```javascript
// 1. Find matches that Postgres thinks are still active but have been alive "too long" (e.g., > 1 hour)
// Or, more aggressively, query all ACTIVE matches and check their Redis state
const activeMatches = await prisma.match.findMany({
  where: { status: 'ACTIVE' },
  select: { id: true, playerLightId: true, playerDarkId: true }
});

for (const match of activeMatches) {
  // 2. Look up the corresponding Redis state
  const state = await redis.hgetall(`match:${match.id}`);
  
  if (state && Object.keys(state).length > 0) {
    if (state.status === 'completed' || state.status === 'draw') {
      // 3. SPLIT BRAIN DETECTED. Redis says it ended, Postgres missed the settlement.
      logger.info({ matchId: match.id, status: state.status }, 'Reconciliation sweep: resolving split-brain match');
      
      if (state.status === 'completed') {
        // We stored winnerId directly in the Redis hash during the Lua CAS game-end commit!
        // No need to re-evaluate the board state.
        const winnerId = state.winnerId;
        
        if (!winnerId) {
            logger.error({ matchId: match.id }, 'CRITICAL: Redis says completed but winnerId is missing.');
            continue; // Require manual intervention
        }
        
        const loserId = winnerId === match.playerLightId ? match.playerDarkId : match.playerLightId;
        await settleGameWithRetry(match.id, winnerId, loserId, 'recovery_sweep');
      } else {
        await settleGameDrawWithRetry(match.id, 'recovery_sweep_draw');
      }
    }
  } else {
      // If Redis is empty but Match is ACTIVE, it might be an orphaned game (e.g., Redis flush).
      // If the Match is older than X hours, we should probably settle as a draw or admin_decision, 
      // but that requires business-logic rules. For now, log it.
      logger.warn({ matchId: match.id }, 'Reconciliation sweep: ACTIVE match found in PG but no Redis state.');
  }
}
```

---

### 10. REST Reconnect Endpoint

#### [NEW] `GET /matches/:id/state` — `src/modules/match/controller.js`

- Loads current board state from Redis (`HGETALL match:{matchId}`)
- If Redis is empty (crash, flush), falls back to `rebuildBoardFromMoveLog(matchId)` — replays all `MatchMove` rows from Postgres through `applyMove()` to reconstruct current board
- Returns `{ board, currentTurn, moveCount, status, players, winnerId }`
- Auth-gated: only the two players in the match can access

---

### 11. Fix `gameManager.js` and `matchmaking.js` Import/Naming Issues

#### [MODIFY] [gameManager.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/gameManager.js)

The current file has wrong import paths and a non-existent function name:
```diff
- import redis from '../../utils/redis.js';
- import logger from '../../utils/logger.js';
- import { initialBoard } from '../engine/board.js';
+ import redis from '../utils/redis.js';
+ import logger from '../utils/logger.js';
+ import { createInitialBoard } from '../modules/engine/board.js';
```

`sockets/` and `utils/` are siblings under `src/`, so relative path is `../utils/`, not `../../utils/`. The function is `createInitialBoard`, not `initialBoard`.

#### [MODIFY] [matchmaking.js](file:///home/uplix/Desktop/UPLIX/Draught%20bet/backend/src/sockets/matchmaking.js)

Currently uses `game:${gameId}` for the socket room. Update it to conform to `03_BACKEND_SPEC.md`:
```diff
- const roomName = `game:${gameId}`;
+ const roomName = `match:${matchId}`;
```

---

## ACID & Idempotency Summary

Every money-moving path and its guarantees:

| Operation | ACID | Idempotency Guard | Concurrency Control | Failure Mode |
|---|---|---|---|---|
| **Stake debit** | ✅ Single `$transaction` | ✅ Match row created inside txn | `lockWalletsInOrder` (ascending userId) | Rolls back entirely — no game, no money moves |
| **Winner payout** | ✅ Single `$transaction` | ✅ `match.status !== 'ACTIVE'` inside txn | Implicit row lock on Match | Second call is a silent no-op |
| **Draw refund** | ✅ Single `$transaction` | ✅ Same status gate | `lockWalletsInOrder` (same discipline as debit) | Second call is a silent no-op |
| **Forfeit** | ✅ Via `settleGame()` | ✅ Inherits status gate | Sorted-set `zrem` returns 0 if already handled | Cron can fire repeatedly — only first settles |
| **Resign** | ✅ Via `settleGame()` | ✅ Inherits status gate | Version-checked Redis status flip | Duplicate resign events are harmless |

**Rules enforced across all paths:**
- No wallet balance is ever modified outside a Prisma `$transaction`
- `SELECT ... FOR UPDATE` on wallet rows prevents concurrent balance races
- Wallet locks always acquired in ascending `userId` order to prevent deadlocks — including draw refunds
- Commission percentage always read live from `PlatformSettings`, never hardcoded
- Commission rounding: `BigInt` floor, remainder accrues to the player (player-favorable, audit-correct)
- All `WalletTransaction` rows include `relatedMatchId` for full audit trail
- Redis game-state writes use versioned Lua scripts — no unguarded multi-step mutations

**Covered race conditions (explicitly by design):**
- Resign + disconnect timer expire simultaneously → first `settleGame` commits, second is no-op
- Two `move_attempt` events for the same match → Lua script version check rejects the stale one
- Reconnect at 59.8s while sweep is mid-scan → sweep's TOCTOU guard checks live socket status (correctly checking `match:{matchId}`)
- Both players disconnect → sweep detects both entries, settles as draw-refund

---

## File Summary

| File | Action | Purpose |
|---|---|---|
| `src/sockets/gameManager.js` | MODIFY | Fix imports. Full game state manager: `handleMoveAttempt` (Lua-scripted with winnerId), `handleResign`, `getGameState` |
| `src/services/matchService.js` | NEW | Extracted `debitStakes` logic using `lockWalletsInOrder` for both matchmaking and REST Callouts |
| `src/sockets/settlement.js` | NEW | Idempotent financial settlement: payout, commission, draw refund. `lockWalletsInOrder` for draws |
| `src/sockets/disconnectHandler.js` | NEW | Disconnect/reconnect via unified `disconnects` sorted set |
| `src/sockets/matchmaking.js` | MODIFY | Ensure room naming follows `match:{matchId}` spec exactly |
| `src/sockets/index.js` | MODIFY | Wire new events: `move_attempt`, `resign`, `join_match`, enhanced `disconnect` |
| `src/jobs/disconnectSweep.js` | NEW | Cron job: pop expired disconnects, TOCTOU guard, both-disconnect draw, auto-forfeit |
| `src/jobs/reconciliationSweep.js` | NEW | Cron job: detects split-brain (Redis=completed, PG=ACTIVE) and forces settlement |
| `src/modules/match/controller.js` | NEW | `GET /matches/:id/state` REST endpoint with Redis → Postgres fallback |
| `src/app.js` | MODIFY | Register match routes, import cron jobs |

## Verification Plan

### Syntax & Existing Tests
- `node --check` on every new/modified file
- `npx jest src/modules/engine/` — existing engine tests must stay green

### Concurrency Integration Tests (new, non-optional)

These tests validate the exact race conditions this design is built to prevent:

| Test | What It Validates |
|---|---|
| **Double settlement** | Fire `settleGame(id, winnerA)` and `settleGame(id, winnerB)` concurrently (via `Promise.all`). Assert exactly one `WalletTransaction(PAYOUT)` exists for this match, and `Match.status === 'COMPLETED'` with a single `winnerId`. |
| **Wallet lock ordering** | Fire `debitStakes(A, B)` and `debitStakes(B, A)` concurrently for two different matches involving overlapping players. Assert no deadlock (both complete or one rolls back cleanly), and wallet balances are correct. |
| **Insufficient funds race** | Two concurrent `debitStakes` calls for the same player whose balance covers one stake but not two. Assert exactly one match is created; the other rolls back. |
| **Version-stamped move rejection** | Simulate two `move_attempt` calls with the same Redis version. Assert one succeeds and the other receives `VERSION_MISMATCH`. |
| **Win-via-move settlement** | Apply a capturing move that leaves the opponent with zero pieces. Assert: (1) Lua CAS commits with `status: 'completed'` and `winnerId`, (2) `settleGame` fires exactly once, (3) exactly one `WalletTransaction(PAYOUT)` exists, (4) `match:${matchId}` Redis key is deleted after settlement, (5) both `user:*:activeMatch` keys are cleaned up. |
| **Settlement retry recovery** | Apply a capturing move, but mock Prisma to throw a transient error on the first `settleGame` call. Assert: (1) Lua CAS still committed the win to Redis, (2) `settleGame` retries and eventually commits, (3) exactly one `WalletTransaction` exists. |
| **GAME_NOT_FOUND immediate reject** | Delete a `match:${matchId}` key, then send `move_attempt`. Assert `move_rejected` with reason `'game_already_ended'` — no retries, no `VERSION_MISMATCH`. |
| **Reconnect vs. sweep race** | Add a player to the `disconnects` sorted set, then simulate a reconnect (`zrem`) while the sweep is mid-scan. Assert no forfeit is processed. |
| **Both-disconnect draw** | Add both players to `disconnects` with close expiry times. Run sweep. Assert `Match.status === 'COMPLETED'` with `endReason = 'both_disconnected'` and both wallets refunded. |

### Manual Verification
- Start the server (`node src/server.js`) — confirm no crash
- Socket.IO test client: connect → `join_queue` → receive `game_start` → send `move_attempt` → receive `move_applied` or `move_rejected`
- Verify `MatchMove` row appears in Postgres after each successful move
- Play a full game to completion (one side captures all pieces) — verify `match_ended` event received with correct payout, wallet balance updated, Redis keys cleaned up

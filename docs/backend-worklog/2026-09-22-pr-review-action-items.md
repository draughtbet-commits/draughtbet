# Backend Action Items — from per-PR contract reviews (our side)

- Author: reviewer (mr-robot), local `refactor/backend-v2` `0883d38` is authoritative.
- Purpose: track backend-side gaps found while reviewing citycod's frontend PR branches.
- **Crosscheck rule applied (2026-09-22):** every candidate backend item is checked against
  the authoritative package `New Folder/Draught_Bet_Backend_Master_Package_v1/`
  (`02_API_and_Realtime/*` contracts, `03_Database_and_Ledger/*`, `04_Repo_Remediation/*`),
  NOT the secondary `docs/backend-handoffs/*`. **This supersedes the earlier crosscheck basis.**
  See the full audit: `docs/backend-worklog/2026-09-22-backend-contract-audit.md`.
- **Verdict correction (2026-09-22):** the master package documents `GET /deposits`,
  `GET /deposits/{depositId}`, `GET /withdrawals`, `GET /withdrawals/{withdrawalId}`,
  `GET /matches/{matchId}/receipt`, socket `wallet.updated` (dot), `match.finished`,
  `settlement.completed`, `opponent.connection`, `game.started`, `player.ready`, and
  `draw.offer`/`draw.respond`. The backend does NOT implement several of these — several
  "frontend drift" calls below are actually contract-mandated features the backend lacks.
- Frontend-facing counterpart: `docs/frontend-handoffs/2026-09-22-contract-guidance-pr4-onward.md`.

Legend: [ ] open, [x] done, [~] blocked/needs decision, [✗] closed — not a backend issue.

---

## PR 4 — match lifecycle (reviewed; backend socket surface matches, draw/result events pending)

- [ ] Backend socket surface (`move.submit`, `match.resign`, `match.join`, `clock.sync`,
      legacy aliases, `match.state`/`game_state` dual emit) is implemented as the master
      socket contract requires. **Outstanding backend items** (from the audit) keep the
      contract's `draw.offer`/`draw.respond`, `match.finished`, `settlement.completed`,
      `game.started`, `player.ready` and `wallet.updated`(dot) from firing/serving:
      the app's listeners/emitters for those are contract-correct, not drift — see
      PR5 B2/B3 above and `docs/backend-worklog/2026-09-22-backend-contract-audit.md`.
      App-side legacy drift that remains app-only: `game_state` fed to the strict parser and
      the unused `wallet.updated` DOT listener (dead until the drainer wires the dot name).

---

## PR 5 — settlement result UI (`ui/pr5-settlement-ui`)

Doc crosscheck result: **both originally-flagged backend items are NOT backend issues.**

- [ ] **B1. Add contract REST endpoints: `GET /matches/{matchId}/receipt` (openapi line 751),
      `GET /deposits/{depositId}`, `GET /withdrawals/{withdrawalId}`, `GET /matches/{matchId}/replay`,
      `POST /matches/{matchId}/disputes`, `POST /matches/{matchId}/ready|cancel`, `GET /me/eligibility`.**
      **Real backend gap** per master package (§5.3 of the audit).
      frontend note: the app's `GET /settlements/{matchId}` and `GET /deposits/quote` are still
      frontend inventions and should be pointed at the contract paths once built.

- [ ] **B2. Emit contract wire events.** Replace/augment `match_ended`/`match_ended_resign` with
      `match.finished` ({matchId,result,terminalReason,stateVersion,settlementStatus}) and emit
      `settlement.completed` ({matchId,receiptId}); deliver `wallet.updated` (dot, as the outbox
      already types it) instead of `wallet_updated`; rename `opponent_disconnected/_reconnected`
      → `opponent.connection`; emit `game.started`. **Real backend gap** (audit §5 A2).

- [ ] **B3. Draw protocol server-side.** Add `draw.offer` / `draw.respond` handlers +
      `pendingDrawOffer` in `match.state`. **Real backend gap** (audit §5 A1).

- [ ] **B4. Receipt `reference` column / synthesis** — revisit when B1 lands; receipts currently
      have no `reference`; contract receipts are `matchId`-keyed so this is cosmetic.

---

## PR 6 — deposit flow UI (`ui/pr6-deposit-ui`)

Re-crosschecked against the master package (supercedes the earlier `docs/backend-handoffs` basis).

- [✗] ~~B1. Deposit quote step decision.~~ **Not a backend issue.** Neither the master contract
      (`POST /deposits`) nor the implemented backend (`POST /wallet/deposit-intent`) has a
      quote step; `/deposits/quote` is frontend invention. Keep single-call quote+initiate.

- [ ] **B2. Add `GET /deposits/{depositId}`.** **Real backend gap** — contract path exists
      (openapi line 494, "Get deposit state"). The app's `GET /deposits/{reference}` is
      contract-shaped; align slot naming once the endpoint exists. Until then the outbox
      `wallet.updated` push + `GET /wallet/transactions` are the fallback.

- [x] ~~B3. Deposit fee handling.~~ (informational, no action) Backend charges no deposit fee;
      app should surface zero/omit `feeMinorUnits`.

- [ ] **B5. Add client Idempotency-Key on deposit create** (contract: `POST /deposits` idempotency
      required). Intents dedupe on server reference only, so a retried checkout could create a
      second intent. **Real gap** (audit §5 B7).

---

## PR 7 — withdrawal flow UI (`ui/pr7-withdrawal-ui`) — not yet reviewed

## PR 8 — game protocol UI (`ui/pr8-game-protocol-ui`) — not yet reviewed
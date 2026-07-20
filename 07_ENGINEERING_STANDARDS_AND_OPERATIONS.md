# 07 — Engineering Standards & Operations

This file is what separates "it works in the demo" from "it survives production with real money in it." It applies across every phase in `06_BUILD_SEQUENCE.md`, not just one week — treat it as a standing checklist, not a one-time task.

## 1. Testing strategy (beyond the game engine)

The engine's test-first approach in `03_BACKEND_SPEC.md` is necessary but not sufficient. Add:
- **Wallet integration tests** — every debit/credit path (deposit, stake, payout, withdrawal) tested against a real (test) Postgres instance, not mocked — money logic bugs hide in the gap between "the unit test mocked the transaction" and "the real transaction actually commits atomically."
- **Socket.IO event tests** — simulate two connected clients, assert `move_applied` reaches both, `move_rejected` reaches only the sender, disconnect → grace period → forfeit fires correctly under a fast-forwarded clock in tests.
- **Flutter widget tests** — at minimum for the board (`CustomPainter` renders expected state given a board fixture), the wallet screen (balance displays correctly, deposit button disabled while a request is in flight), and auth forms (validation states).
- **CI gate:** the pipeline from `06_BUILD_SEQUENCE.md` Week 1 should fail the build if engine or wallet tests fail — these two suites are non-negotiable gates, not advisory.
- **Coverage isn't the goal, scenario completeness is.** Don't chase a percentage number — chase "every money-moving code path and every game-ending condition has at least one test," which is a much shorter, more meaningful list.

## 2. Observability & logging

- Structured logging via `pino` (already in the stack) — every log line is JSON, not a formatted string, so it's queryable later.
- **Never log:** passwords (even hashed), JWTs, refresh tokens, full card/payment details, raw webhook payloads containing gateway secrets.
- **Always log at `info` level:** every wallet transaction (already covered by the `WalletTransaction` table, but mirror it to logs for real-time grep-ability during incidents), every admin mutation (mirrors `AdminAuditLog`), every match start/end.
- **Log at `warn`:** rejected moves (could indicate either a client bug or an attempted exploit — worth watching in aggregate), failed webhook signature verifications.
- **Log at `error`, and alert via Sentry:** any failed Prisma transaction on a wallet-affecting path, any Socket.IO disconnect-sweep failure, any webhook processed with a mismatched idempotency check.
- Sentry alert thresholds: anything tagged `error` on a wallet or engine code path pages you immediately, not just accumulates in a dashboard — set this up in Week 1 alongside the Sentry project creation, not as an afterthought.

## 3. Secrets & credential hygiene

- `.env` files are never committed — verify `.gitignore` covers this in Week 1, don't assume.
- Separate credentials per environment (local/staging/production) — a leaked staging Paystack test key should never be the same key protecting production money.
- Database connection uses a role with only the privileges the app needs — not the Postgres superuser, even in early development, since habits formed in Week 1 tend to persist to production.
- **Key rotation:** rotate Paystack/Flutterwave API keys if anyone with access to them leaves the project, and on a routine basis (quarterly is a reasonable default) even without a specific trigger. Document who has access to which keys — a one-line list is enough at this team size, but it should exist.
- If a key does leak (committed accidentally, shared insecurely): rotate it immediately at the gateway dashboard first, then clean the git history — in that order, since a rotated leaked key is inert, but a "cleaned" repo with a still-valid leaked key is not actually fixed.

## 4. Data protection & privacy (Nigeria Data Protection Act / NDPR)

The app collects genuinely sensitive data: email, KYC verification data, device fingerprints, IP addresses, financial transaction history. Nigeria's Data Protection Act (2023) and NDPR apply directly.
- KYC-related data (once the platform collects any) is encrypted at rest, not just protected by database access controls.
- Minimize retention — don't keep KYC documents/data longer than needed for the verification purpose plus whatever regulatory retention period applies; this needs a specific answer from the client's legal counsel, not an engineering guess, but the *system* should support deletion once an answer exists (don't build an architecture where deleting a user's data is structurally hard).
- Account deletion (a real feature, even if not explicitly speced yet in `04_FRONTEND_SPEC.md` — add it before launch) should anonymize personal data rather than leave orphaned PII, similar in spirit to how you handled this on Tutaly.
- Any access to another user's PII (an admin looking up a user's KYC status, for instance) should itself be logged — see §2 — since "who looked at this person's sensitive data and when" is itself a compliance question, not just a security one.

## 5. Backup & disaster recovery

- **PostgreSQL (VPS-hosted):** Automated daily backups via `pg_dump` cron jobs shipped to cold storage (e.g., S3). We are using a dedicated local Postgres 15 instance to eliminate network hops and absolutely guarantee sub-100ms latency for `MatchMove` inserts. This is where the money ledger lives; losing it is not an acceptable failure mode under any circumstance.
- **Redis — the actual gap:** live match board state and the matchmaking queue live in Redis. If Redis restarts mid-match, what happens right now is undefined, and that's a real problem given there's money staked on that match. Fix:
  - Enable Redis AOF (append-only file) persistence, not just RDB snapshots, so a restart loses at most the last few operations rather than everything since the last snapshot.
  - **More importantly:** build the recovery path explicitly — since every move is also written to Postgres's `MatchMove` table (per `02_DATABASE_SCHEMA.md`), a lost Redis board state should be reconstructible by replaying `MatchMove` rows for that match, not just accepted as data loss. Add this as an explicit function (`rebuildBoardFromMoveLog(matchId)`) and test it deliberately — this is exactly the kind of thing that's easy to leave unbuilt because it only matters during an incident, which is precisely why it needs to be built before one happens.
- Test the backup restore process at least once before launch — an untested backup is a hope, not a plan.

## 6. Performance budgets

Stated numbers, not vibes — these should be the explicit targets validated in Week 12's load testing (`06_BUILD_SEQUENCE.md`):
- Socket.IO move round-trip (client emits `move_attempt` → both clients receive `move_applied`): **under 100ms** under normal load.
- API p95 latency for non-real-time endpoints (auth, wallet balance, match history): **under 300ms**.
- Matchmaking queue pop-to-pair latency: **under 5 seconds** once two compatible players are queued (the `node-cron` worker interval in `03_BACKEND_SPEC.md` is 3s specifically to support this).
- If Week 12 load testing shows any of these missed under the 50–100 concurrent match target, that's a blocking finding for Week 13, not a "nice to fix later."

## 7. Concurrency & race-condition audit checklist

Beyond the call-out double-accept lock already specified in `03_BACKEND_SPEC.md`, explicitly check:
- **Two admins approving the same withdrawal simultaneously** — the `PATCH /admin/withdrawals/:id/approve` handler needs the same `SELECT ... FOR UPDATE` row-lock pattern as call-out acceptance, or a status-check-then-update race lets a withdrawal get double-processed.
- **Matchmaking worker double-pairing** — if the `node-cron` tick takes longer than its 3s interval under load, a second tick could start before the first finishes; use a simple Redis lock (`SETNX`) around each matchmaking run to prevent overlapping executions.
- **Wallet debit-credit ordering** — always debit before credit within a transaction (not simultaneously as two independent statements) so a failure partway through fails safe rather than creating money.
- Treat "could two of these happen at the same time under load" as a standing question for every new mutating endpoint, not just the ones already identified here.

## 8. Incident response & kill switches

Build these before launch, not after the first incident makes their absence obvious:
- **Admin-level platform pause:** a single `PlatformSettings` flag (or small set of flags) an admin can flip to immediately stop new deposits, new matchmaking pairings, and new withdrawal approvals — without needing a code deploy. This is the single most important thing to have ready before real money is live, because the alternative during an actual incident is "redeploy under pressure," which is how incidents get worse.
- **Rollback plan:** know, in writing, how a bad PM2 deploy gets rolled back on the Contabo VPS before you need to do it live — this can be as simple as "keep the previous release directory and a documented `pm2 reload` step," but it needs to be documented, not improvised.
- **Runbook expectation:** for the top 3 realistic incidents (Redis loss mid-match, a payment webhook failure spike, a Play Store takedown/suspension) write a short "what to check, what to do" note — a paragraph each is enough at this stage, but "we'll figure it out live" is not an acceptable answer for a money-handling app.

## 9. Dependency & code hygiene

- Run `npm audit` (or equivalent) as part of CI, not just manually and occasionally.
- Pin exact versions for anything on a wallet-affecting code path's dependency chain — a silent minor-version bump in a payment or crypto library is not where you want a surprise.
- Every PR (even solo-authored) gets checked against `00_MASTER_PROMPT.md` §6's Definition of Done before being considered mergeable — treat this as a literal checklist, not a vibe check, precisely because there's no second engineer here to catch what you miss.

## 10. Legal content ownership

Privacy policy, terms of service, and any regulatory-facing copy (Contract §11's UKGC-style disclaimers, the Nigeria-specific regulatory note in `01_PRODUCT_CONTEXT.md`) should be **drafted or reviewed by an actual lawyer**, not written by Antigravity as filler text and shipped. Antigravity's job is to build the CMS/display/versioning mechanism for these pages (per `06_BUILD_SEQUENCE.md` Week 14) — the substantive legal language is a business risk item for Mr. Livingstone and Uplix to source properly, and placeholder legal text should be clearly marked as such in the codebase (e.g., a `// TODO: LAWYER-REVIEWED TEXT NEEDED` comment) so it's never accidentally shipped to production unreviewed.

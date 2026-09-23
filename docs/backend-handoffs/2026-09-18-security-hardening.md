# Backend handoff: Security & production hardening (PR 13)

Date: 2026-09-18
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter client and Citycod review

## Summary

Operational hardening pass: TOTP MFA for admin egress surfaces, refresh-token
rotation with reuse detection, route-specific rate limiting, KYC privacy
guardrails, secret scanning and least-privilege checks, load + backup drills,
and a layered verification harness.

## Client-visible changes

- **Admin MFA (`x-admin-mfa-code`)** only exists under `/admin/*`; the player
  API is untouched. An admin that has not enabled MFA is served `403` while
  enforcement is on (set via `ADMIN_MFA_ENFORCED=true`, or production default
  true — dev default is off, so the player surface needs nothing).
- **Refresh tokens rotate on every use.** The old refresh token is dead as
  soon as it is used; if it is ever *replayed after rotation*, all sessions for
  that account are revoked and a `REFRESH_REUSE_DETECTED` security event is
  written. Any Flutter client that refreshes correctly is unaffected — the new
  token it receives is the only valid one.
- **Rate limits** are per-surface (strictest on auth/admin/wallet). A user
  hitting the login limiter does not affect other routes and vice-versa. Limits
  are generous for normal play.
- **KYC privacy**: provider responses are scrubbed before storage and the admin
  case list masks names/emails — UI sees `m.***@***.com`-style values, not the
  raw values.

## What an operator must set (new env vars)

- `ADMIN_MFA_ENFORCED=true` to require MFA on `/admin/*` (recommended).
- `ADMIN_MFA_SECRET_KEY` — 64-char hex AES key; **required in production**,
  the app refuses to boot without it (or with the sample value). Dev/test
  fall back to a derived dev key.
- `ADMIN_CORS_ORIGIN` — the single allowed admin origin (e.g.
  `https://admin.draughtbet.com`); **required in production**, refuses to boot
  without it. When set, CORS only echoes that exact request origin.
- `APP_ENFORCE_TLS=true` to force TLS (GET/HEAD 301-redirect, non-idempotent
  methods 403, `/health` exempt).

## New scripts and checks (all verified this session)

- `scripts/verify/pr13-security-hardening.mjs` — S1..S10 probe suite
  (refresh reuse, logout, full TOTP lifecycle + brute-force lock, encrypted
  secret, limiter isolation, security headers, CORS restrict, TLS enforce,
  production boot guards, privilege/secret scripts). **10/10 PASS** against a
  wiped DB + Redis; cleans up after itself.
- `scripts/check-privileges.sh` — DB role least-privilege + Redis CONFIG/ACL
  audit; exit 0 with WARNs on a dev (superuser) box, `--strict` for prod.
- `scripts/scan-secrets.sh` + `.gitleaks.toml` — gitleaks over **tracked files
  only** (local `.env` is never scanned); also wired as a CI `secret-scan` job.
- `scripts/backup-restore-drill.sh` — dump → scratch restore → ledger zero-sum
  verification → cleanup.
- `scripts/load/backend-load.mjs` — autocannon load test against the live app.

## Roughly three latent bugs found and fixed by the harness/tests

1. `UserSession.refreshTokenHash` lacked its unique index, so **every refresh
   call 500'd** (`findUnique` required a unique field). Added `@unique` via
   migration `20261002000000_session_refresh_unique`. Unit tests had mocked the
   find path, so they never saw it.
2. The `pr13_security_hardening` migration `ALTER TABLE "Withdrawal"` ran
   before the v2 migration created `Withdrawal`, so a **fresh deploy (and any
   shadow-DB replay) failed**. Renamed to `20261001000000` (after all
   predecessors) and confirmed: full fresh replay of the whole chain into a
   scratch DB now applies cleanly end-to-end.
3. Stacked rate limiters were silently defeated: express-rate-limit's
   `singleCount` validation aborted the *increment* of the second (route)
   limiter on a stacked request, so route budgets barely counted. Disabled the
   validator (stacking is intentional) — the isolation probe now verifies
   real Redis bucket counts.
4. CORS with a pinned `ADMIN_CORS_ORIGIN` echoed it on *every* request
   regardless of the request's `Origin`. Now only the exact configured origin
   gets CORS headers.

## Verification status

- Harness `scripts/verify/pr13-security-hardening.mjs`: 10/10 PASS.
- Unit battery: **55 suites passed, 14 skipped (gated integration), 495 tests
  passed.**
- Fresh migration chain replay into scratch DB: all migrations apply (incl.
  the reordered pr13).
- Load (health ~1.3k rps, login ~18 rps @ bcrypt), backup/restore drill and
  privilege/secret scans were exercised live earlier this session.

## Bookkeeping

- Pull requests 9–12 already committed locally (`77655bd`, `0430471`,
  `a856dab`, `fdfeec3`). PR 13 is the final one in the plan and is committed
  locally on `refactor/backend-v2` — **no pushes have been made**; user to
  confirm before anything is pushed.
- Not staged (kept out of commits): `.env*`, `app/test/failures/`,
  `Security Audit/`, `.analysis_results.md.swp`; the PR tracker is gitignored.
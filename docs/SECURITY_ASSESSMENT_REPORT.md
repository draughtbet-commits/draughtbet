# DraughtBet Platform Security Assessment Report

**Assessment Date:** 2026-11-20  
**Branch:** `ui/password-recovery-ui`  
**Scope:** Backend API & Socket.IO (`backend/src`), Admin Web Console (`admin-web/src`), Runtime Environment Posture (`backend/.env`, `backend/.env.sim`), and Automated Security Test Suites

---

## 1. Executive Summary

A source-code security audit, static pattern scan, environment posture check, and automated security unit test run were performed across DraughtBet's backend and admin web interfaces.

Core server-side authorization boundaries—specifically database-backed RBAC enforcement, double-entry ledger protections, Socket.IO room authorization, fail-closed JWT/CORS startup checks in production, and sanitized error handling—are well structured and verified by unit tests. Five concrete security gaps were identified for remediation prior to production exposure: **2 High**, **2 Medium**, and **1 Low**.

---

## 2. Automated Verification Summary

### 2.1 Security & Authorization Test Suites
Executed in offline unit-test mode (`NODE_ENV=test`, `REDIS_URL=""`, `DATABASE_URL=""`, `DOTENV_CONFIG_PATH=NUL`):

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js securityBoundaries jwtEnv webhook rateLimit tierEnforcement simulation audit auth admin saferPlay payloadGuard
```

| Metric | Result | Notes |
| --- | --- | --- |
| Test Suites Passed | **14 / 17** (`0` failed) | `securityBoundaries.test.js`, `jwtEnv.test.js`, `webhookController.test.js`, `webhook.test.js`, `rateLimit.test.js`, `tierEnforcement.test.js`, `simulation.test.js`, `audit.test.js`, `admin.test.js`, `auth.test.js`, `saferPlay.service.test.js`, `saferPlay.test.js`, `payloadGuard.test.js`, `provisionDevAdmin.test.js` |
| Individual Tests Passed | **169 passed** | `0` failed |
| Skipped Integration Suites | **3 suites (`26` tests)** | `security.verification.test.js`, `admin.integration.test.js`, and `refresh.integration.test.js` require `RUN_DB_INTEGRATION=1` against live PostgreSQL and Redis |

### 2.2 Static Dangerous-Pattern Scan (`backend/src` & `admin-web/src`)
| Pattern Checked | Matches Found | Notes |
| --- | --- | --- |
| `$queryRawUnsafe` / `$executeRawUnsafe` | `0` | Prisma parameterized queries used |
| `dangerouslySetInnerHTML` | `0` | — |
| JavaScript `eval(` / `new Function(` | `0` | Only atomic Redis Lua `redis.eval(` scripts in `backend/src/modules/auth/service.js` and `backend/src/sockets/*` |
| `rejectUnauthorized: false` | `0` | — |
| Browser `localStorage` session storage | Present (`admin-web`) | Tracked as High Finding #1 |

---

## 3. Verified Defense-in-Depth Controls

- **RBAC Authority & Immutable Governance (`backend/src/modules/rbac/service.js`, `admin/controller.js`, `config/controller.js`, `featureFlags/controller.js`, `maintenance/controller.js`):**
  - Admin permissions (`hasPermission`) query `adminRoleAssignment` freshly from PostgreSQL per request rather than trusting JWT claims.
  - All admin, config, feature-flag, maintenance, notification-template, and audit routes enforce `requireAuth` alongside `requirePermission(...)` or `requireAnyAdminRole`.
  - Feature flags marked `isProtectedInvariant` (e.g. `enforce_kyc_on_withdrawal`) cannot be disabled or weakened (`ProtectedInvariantError`).
  - Configuration activation enforces Maker-Checker separation (`MakerCheckerViolationError`) and immutability (`ImmutableVersionError`); role revocation blocks removing the last `SUPER_ADMIN`.
  - Admin actions and authorization denials (`DENIED`) are recorded in `AdminAuditLog`.
- **Session Lifecycle & Revocation (`backend/src/modules/auth/service.js`, `middleware/auth.js`, `sockets/middleware.js`):**
  - Access JWTs expire in `15m`; refresh tokens are stored as SHA-256 digests (`hashRefreshToken`) in `UserSession` and rotated atomically via Redis Lua (`ROTATE_SCRIPT`).
  - Replay of an already-rotated/revoked refresh token triggers `REFRESH_REUSE_DETECTED` and revokes every session belonging to that user (`revokeAllRefreshTokens`).
  - Both `requireAuth` and `socketAuthMiddleware` re-verify `user.isBanned` from PostgreSQL on HTTP requests / socket handshakes, and account suspension or logout calls `getIO().in('user:' + userId).disconnectSockets(true)`.
- **IDOR & Socket Hardening (`backend/src/modules/match/controller.js`, `sockets/disconnectHandler.js`, `sockets/index.js`):**
  - Non-participants receive HTTP `403` on `/api/v1/matches/:id/state` and `'Not a participant'` on Socket.IO `match.join`.
  - Socket.IO limits payloads (`maxHttpBufferSize: 16 * 1024`), caps concurrent sockets per user (`MAX_SOCKETS_PER_USER`), rate-limits events (`consumeBudget`), and disconnects sockets once their access token expires (`guardSocketHandler`).
- **Fail-Closed Startup & PII Protection (`backend/src/app.js`, `utils/jwtEnv.js`, `middleware/requestId.js`, `verification/service.js`):**
  - Production startup refuses missing `ADMIN_CORS_ORIGIN`, missing `JWT_SECRET`, or known sample secrets (`'your-super-secret-jwt-key'`, `'test_secret'`).
  - `finalErrorHandler` returns `INTERNAL_ERROR` + `requestId` without leaking stack traces or database internals.
  - KYC provider responses pass through `sanitizeProviderResponse` (`ALLOWED_RESULT_KEYS` + `PII_VALUE_SNIFFER`), and document access uses `120s` ephemeral HMAC tokens without raw storage URLs.

---

## 4. Findings & Remediations

### [High] 1. Admin Session & Refresh Tokens Stored in `localStorage` Without HTTP Security Headers
- **Locations:**  
  - `admin-web/src/lib/api/client.ts` (`ACCESS_TOKEN_KEY`, `REFRESH_TOKEN_KEY`, lines 47–62)  
  - `admin-web/src/lib/auth/AuthContext.tsx` (lines 29–36, 190)  
  - `admin-web/next.config.ts` (lines 1–17)
- **Risk:** Both privileged access and refresh tokens (`SUPER_ADMIN`, `FINANCE`, `RISK_COMPLIANCE`, etc.) are persisted in `localStorage`, which is readable by any JavaScript executing on the origin. Additionally, `admin-web/next.config.ts` does not define `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` headers, enlarging any potential XSS or clickjacking blast radius to full admin account takeover.
- **Remediation:**
  1. Issue and refresh admin sessions via `HttpOnly; Secure; SameSite=Strict` cookies backed by CSRF token verification on state-changing requests.
  2. Define strict `headers()` in `admin-web/next.config.ts` (`Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`).

---

### [High] 2. Production Environment Flags & Flutterwave Webhook Hash Gaps (`backend/.env`)
- **Locations:**  
  - `backend/.env` (`NODE_ENV=production`)  
  - `backend/src/app.js` (lines 72–80)  
  - `backend/src/modules/payment/FlutterwaveGateway.js` (lines 8–12, 96–103)  
  - `backend/.env.sim.example` (line 24)
- **Observation:** Non-secret runtime posture inspection of `backend/.env` showed:
  - `APP_ENFORCE_TLS` is unset (`null`), meaning the app-level TLS check (`if (process.env.APP_ENFORCE_TLS === 'true')`) is inactive.
  - `FLUTTERWAVE_SECRET_HASH` is unset (`false`), causing `/webhooks/flutterwave` signature verification to fail closed with `401` (`!this.secretHash`). Note also an environment variable naming mismatch: `backend/.env.sim.example` defines `FLUTTERWAVE_WEBHOOK_SECRET`, whereas `FlutterwaveGateway` reads `process.env.FLUTTERWAVE_SECRET_HASH`.
  - `JWT_REFRESH_SECRET` is unset (note `AuthService.issueTokens` currently issues UUID refresh tokens hashed with SHA-256 rather than signed JWTs, so this does not break refresh issuance, but env docs should align).
- **Remediation:**
  1. Set `APP_ENFORCE_TLS=true` in production deployments behind a verified TLS-terminating proxy (`TRUST_PROXY=1`).
  2. Set `FLUTTERWAVE_SECRET_HASH` in production and align `backend/.env.sim.example` (`FLUTTERWAVE_SECRET_HASH` instead of `FLUTTERWAVE_WEBHOOK_SECRET`), failing closed on boot in `production` if active payment gateway secrets are missing.

---

### [Medium] 3. Non-Constant-Time Webhook Signature Comparisons & Unvalidated JSON Shapes
- **Locations:**  
  - `backend/src/modules/payment/PaystackGateway.js` (lines 92–99)  
  - `backend/src/modules/payment/FlutterwaveGateway.js` (lines 96–103)  
  - `backend/src/modules/payment/webhookController.js` (lines 41–147)
- **Risk:**
  - Both `PaystackGateway.verifyWebhookSignature` (`return hash === signatureHeader;`) and `FlutterwaveGateway.verifyWebhookSignature` (`return signatureHeader === this.secretHash;`) compare secrets using standard `===` string equality instead of `crypto.timingSafeEqual` with type and byte-length guards, exposing webhook verification to timing side-channels.
  - `webhookController.js` parses `JSON.parse(rawBody.toString('utf8'))` and reads `payload.data.reference` / `payload.data.status` without schema validation; malformed payloads missing `data` throw unhandled `TypeError`s into HTTP `500` instead of returning `400`.
- **Remediation:**
  1. Guard `typeof signatureHeader === 'string'`, decode/encode into equal-length `Buffer`s, and compare using `crypto.timingSafeEqual`.
  2. Validate parsed webhook payloads with Zod before processing and return HTTP `400` on malformed event bodies.

---

### [Medium] 4. Pre-Auth Account & Suspension Enumeration in Login + Unauthenticated Availability Oracle
- **Locations:**  
  - `backend/src/modules/auth/service.js` (`login`, lines 168–186; `checkAvailability`, lines 212–228)  
  - `backend/src/modules/auth/controller.js` (lines 112–165)  
  - `backend/src/middleware/rateLimit.js` (`checkRateLimiter`, lines 177–182)
- **Risk:**
  - `AuthService.login` returns immediately on `!user` without running `bcrypt.compare`, creating a measurable timing distinction between existing and non-existent emails/phones.
  - When `user` exists, `user.isBanned` is checked *before* `bcrypt.compare(password, user.passwordHash)` and returns a distinct `'Account suspended'` error (`controller.js:127–128`), allowing unauthenticated callers to enumerate whether specific accounts exist and are banned without knowing passwords.
  - `POST /api/v1/auth/check-availability` exposes an unauthenticated identifier existence check rated at `60` requests/min per IP (`checkRateLimiter`).
- **Remediation:**
  1. Perform a constant-cost dummy `bcrypt.compare` when no user record is found.
  2. Verify the password hash *before* inspecting or surfacing `isBanned`, or return a uniform authentication failure message until credentials are verified.
  3. Require a CAPTCHA/challenge token or move identifier uniqueness checks behind registration submission / tighter throttling if pre-auth enumeration violates threat requirements.

---

### [Low] 5. Admin MFA Schema Not Enforced at Login & Integration Security Suite Skipped Offline
- **Locations:**  
  - `backend/src/modules/auth/controller.js` (lines 112–132)  
  - `backend/src/modules/admin/__tests__/security.verification.test.js` (lines 20–23)
- **Risk:** While `User.adminMfa` exists in the Prisma schema, admin logins via `POST /api/v1/auth/login` issue access tokens solely on email/password without enforcing a TOTP/MFA step. Additionally, the DB/Redis integration assertions in `security.verification.test.js` were skipped in offline test mode.
- **Remediation:**
  1. Require enrolled MFA verification (`adminMfa`) before issuing `adminRouter`-capable sessions to admin accounts.
  2. Execute `RUN_DB_INTEGRATION=1` CI runs against isolated PostgreSQL and Redis instances to exercise `security.verification.test.js`, `admin.integration.test.js`, and `refresh.integration.test.js` on every merge.

---

## 5. Priority Action Plan

1. **Immediate (Production Blockers):** Migrate admin auth tokens off `localStorage` into `HttpOnly` cookies + add strict CSP/security headers in `admin-web/next.config.ts`; configure `APP_ENFORCE_TLS=true` and `FLUTTERWAVE_SECRET_HASH` in production runtime secrets and align `.env.sim.example`.
2. **Short-Term (Hardening):** Switch webhook signature verification to `crypto.timingSafeEqual` + Zod body validation; fix login timing & pre-auth `isBanned` disclosure in `AuthService.login`.
3. **Follow-Up:** Enforce `adminMfa` on admin logins and run `security.verification.test.js` with `RUN_DB_INTEGRATION=1` in CI.

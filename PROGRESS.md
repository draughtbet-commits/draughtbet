# Draughts Arena — Project Progress & State

**Last Updated:** September 23, 2026

## ⏳ Current Status: Week 10 (Admin Backend)

## Flutter UI PR Progress

### PR4–PR8 Backend V2 Contract Alignment — Completed Locally

- **Source branch:** `ui/pr4-pr8-contract-alignment`
- **Integration target:** `refactor/backend-v2`
- **Worktree:** `/home/uplix/uplix/draughtbet-pr4-pr8-audit`
- **Topology verified:** PR4 → PR5 → PR6 → PR7 → PR8 remains sequential.
- **Scope:** Flutter contract alignment only. No backend files were changed.

#### Completed repairs

- Added an explicit `BACKEND_CONTRACT` switch. It defaults to `legacy`; V2 routes and Socket.IO events are enabled only when configured.
- **PR4 — Match lifecycle:** maps the V2 match, matchmaking, ready, cancel, stake, and release contracts while retaining the legacy path; waits for authoritative match-found state and preserves idempotency keys across uncertain mutations.
- **PR5 — Settlement results:** renders only server-provided outcomes and amounts, reads the V2 receipt contract, and consumes authoritative `settlement.completed` events without initiating settlement.
- **PR6 — Deposits:** creates V2 deposit intents with idempotency and safely reads deposit status; hosted-checkout return never implies success.
- **PR7 — Withdrawals:** maps V2 bank-account and withdrawal endpoints with idempotency and masking; keeps the action unavailable when the server cannot provide an authoritative quote.
- **PR8 — Gameplay protocol:** connects to the V2 `/game` namespace, maps canonical events, resyncs safely, renders server clocks/disconnect grace, and rejects unresolved board encodings instead of inventing a client mapping.
- Added focused V2 request/response regression coverage and updated existing gameplay/settlement tests for the aligned contracts.

#### Local correction commits

- `03b687c` — PR4 match lifecycle contract alignment
- `e24b0dc` — PR5 settlement contract alignment
- `35cd7c5` — PR6 deposit contract alignment
- `c29773e` — PR7 withdrawal contract alignment
- `03b1e20` — PR8 game protocol contract alignment
- `28feeb3`, `5c359a4`, `b3ac318` — PR4 cross-audit, visual, and stale-test follow-ups

#### Verification

- Focused contract/lifecycle/gameplay/settlement tests: **62 passed, 0 failed**
- Complete Flutter suite after Backend V2 integration: **207 passed, 0 failed**
- `flutter analyze`: **No issues found** (September 23, 2026)
- Android debug APK: **built successfully** (September 23, 2026)
- APK path: `app/build/app/outputs/flutter-apk/app-debug.apk`
- APK SHA-256: `1ae83467db3d1738b33b6d305ea1cbf5946820241fafad6f5d7a647856ad4e7c`
- `git diff -- backend`: **empty**

#### Remaining backend contract blockers

- No deposit payment-method or quote-discovery contract is available, so Flutter cannot safely invent provider options, fees, or currency choices.
- No withdrawal quote/eligibility contract provides authoritative fee, net amount, and limit values, so submission remains unavailable until those values exist.
- No settlement-status read endpoint is documented; Flutter relies on authoritative result/receipt reads and settlement events.
- The final canonical board encoding and square numbering are unresolved in the Backend V2 contract, so unknown encodings are rejected and resynced.
- No chat send/history API, Socket.IO event contract, or persistence contract exists; gameplay chat remains unavailable.

#### Remote status

- The earlier audit baseline exists remotely as `ui/pr4-pr8-contract-alignment` at `b3ac318`.
- The latest Backend V2 contract-alignment changes and verification results remain local until explicitly pushed.
- No backend file was changed by this Flutter alignment batch.
- The unrelated modified `Draught_Bet_Approved_UI_UX_Handoff_v1/index.html` in the original checkout remains untouched.

#### Next UI PR

PR9 — Server Clock + Reconnect UI is the next new Flutter implementation after this audit.

## ✅ Completed Phases

### 1. Requirements & Analysis Phase
- **Fully Reviewed:** All project specifications including the Phase 1 MVP pivot (Nigeria-first, NGN currency, Paystack/Flutterwave gateways).
- **Architecture Finalized:** The canonical schema was audited and updated to use `BigInt` minor units (kobo) and explicit bounds for normal matchmaking vs. high-stakes call-outs.
- **Output:** The synthesized project spec is saved in `analysis_results.md`.

### 2. Week 1: Infrastructure & Scaffolding
- **Backend Setup:**
  - Migrated the `backend` codebase directly into this `Draught bet` folder.
  - Updated `backend/prisma/schema.prisma` to precisely mirror the canonical NGN schema.
  - Set up a local `.env`.
  - Created a `docker-compose.yml` configured for PostgreSQL 15 and Redis 7 (with the mandatory AOF persistence enabled for recovering active matches).
  - Configured GitHub Actions CI in `.github/workflows/ci.yml`.
- **Frontend Setup:**
  - Scaffolded the Flutter application inside the `app/` directory.
  - Created `pubspec.yaml` with all necessary Phase 1 packages (e.g., `webview_flutter` for payments, excluding Stripe).
  - Built the `lib/` directory structure and stubbed out all required screens in `lib/router/app_router.dart`.
  - Configured `main.dart` with the strict "Void and Gold" dark-mode theme.

### 3. Week 2 & 3: Game Engine & Authentication System
- **Game Engine Implementation:**
  - Built the pure JavaScript Game Engine (`src/modules/engine/`) for 10x10 International Draughts.
  - Implemented the 1D array board state mapping.
  - Enforced move validation including the Mandatory Maximum Capture rule and multi-jump logic.
  - Added draw detection (threefold repetition position hash map, 25-consecutive-king-move draw, etc.).
  - Authored and successfully passed exhaustive Jest test coverage (`__tests__/engine.test.js`).
- **Auth Module Built:** 
  - Implemented `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, and `/auth/me` per the spec.
  - Registration is wrapped in an atomic Prisma `$transaction` (User + Wallet + Fingerprint).
  - Explicitly added `isBanned` checks to prevent suspended users from logging in.
- **Security & Token Rotation:**
  - JWT Access Tokens (15m) and Redis-backed Refresh Tokens (7d).
  - Explicit token rotation and active Redis deletion on logout/refresh.
  - Rate Limiting: 100/min global, 5/min on Auth endpoints via Redis with in-memory fallback.

### 4. Week 4 & 5: Real-time Integration & Matchmaking/Call-outs
- **Socket.IO Integration:**
  - Wire up client-server events: `move_attempt`, `resign`, `join_match`, `disconnect`.
  - Atomic Redis Compare-And-Swap (CAS) Lua script (`game_state_cas.lua`) preventing concurrent move board corruption.
  - Disconnect handling via unified `disconnects` Redis sorted set with 60s grace period and `disconnectSweep` cron job.
- **Matchmaking & Call-outs:**
  - Redis matchmaking queues + matchmaking worker.
  - Call-out REST endpoints (`POST /callouts`, `POST /callouts/:id/accept`) and call-out expiry sweep cron job.

### 5. Week 6: Wallet & Payment Gateway Backend
- **Audit & Implementations:**
  - `PaymentGateway` interface with `PaystackGateway` and `FlutterwaveGateway` implementations.
  - HMAC-SHA512 (Paystack) and `verif-hash` (Flutterwave) signature verification on webhooks.
  - Atomic Prisma transactions for deposit processing with `P2002` duplicate webhook idempotency.
  - Immediate balance deduction on withdrawal requests to prevent double-spending.
  - Ascending `userId` wallet locking (`lockWalletsInOrder`) for deadlock-free stake debits and draw refunds.
  - Idempotent game settlement (`settleGame` and `settleGameDraw`) with live `commissionPercent` calculation and `wallet_updated` socket emits.

### 6. Week 7: Wallet UI + Tier Enforcement Checkpoint
- **Flutter Wallet Screen:** Built complete wallet UI featuring NGN balance chip, deposit modal (Paystack/Flutterwave selector), and paginated transaction history list.
- **Webview Checkout:** Integrated `webview_flutter` for the `authorizationUrl` checkout flow.
- **Live Sync:** Wired the `wallet_updated` socket event directly into Riverpod state for instant balance updates.
- **Tier Clamping (Lobby):** Connected `GET /wallet/tier-limits` to `TierSelectScreen`, dynamically bounding matchmaking and call-out sliders.
- **Navigation Shell:** Implemented `go_router` `ShellRoute` providing persistent `BottomNavigationBar` bridging Lobby, Wallet, Results, and Settings.

### 7. Week 8: Notifications System
- **Backend Notifications (Postgres + Socket.IO):**
  - Created `NotificationService` and `NotificationController` with `fcmToken` storage logic.
  - Plumbed `NotificationService.create` into 8 strategic triggers (`DEPOSIT_CONFIRMED`, `CALLOUT_RECEIVED`, `MATCH_FOUND`, `MATCH_ENDED_WIN`/`LOSS`, `DISCONNECT_WARNING`, etc.).
- **Frontend Integration (Flutter):**
  - Built `NotificationProvider` with Riverpod for real-time socket ingestion (`onNotification`).
  - Implemented `NotificationBell` with dynamic unread badging placed in Lobby App Bar.
  - Created `_NotificationPanel` modal sheet for rapid triage with deep-link navigation.
  - Integrated `FCMService` stub utilizing `flutter_local_notifications` for foreground banners.

### 8. Week 9: Security, Anti-Cheat & Complete Frontend UI
- **Security & Anti-Cheat:**
  - Server-side engine re-validation on every incoming socket move before CAS execution.
  - Device fingerprinting and IP anomaly logging integrated into registration/login.
  - Hardened Redis and rate-limiting connection error handling with graceful in-memory fallback.
  - Direct Neon PostgreSQL connection configured and schema synced (`npx prisma db push`), creating all tables (`Match`, `Callout`, `User`, `Wallet`, `WalletTransaction`, `Notification`, `AdminAuditLog`, etc.).
- **Complete Frontend UI Screens (Flutter):**
  - **Auth:** `LoginScreen` & `RegisterScreen` with password strength meter, DOB 18+ age validation, and error alerts.
  - **Lobby:** `TierSelectScreen` with dynamic tier clamping (`GET /wallet/tier-limits`), matchmaking queue controls, open call-outs list with countdown timers, call-out creation dialog.
  - **Gameplay:** `MatchScreen` with 10x10 International Draughts `CustomPainter` board rendering, legal destination highlights, move attempt emission, resign action, syncing overlay, win/loss overlay.
  - **Wallet:** `WalletScreen` with Naira balance chip, Paystack/Flutterwave deposit modal (`CheckoutWebviewScreen`), withdrawal request modal, and paginated transaction history list.
  - **Match Results:** `ResultsScreen` wired to `GET /matches/history`, displaying status badges (VICTORY, DRAW, DEFEAT), tier tags, opponent email, date, and Naira stake/winnings.
  - **Settings & Legal:** `SettingsScreen` with user profile info, tier badge, push notification & sound switches, modal sheets for Terms of Service & Privacy Policy, app version info, and logout confirmation modal.
  - **Navigation & Shell:** `MainLayout` bottom navigation bar bridging Home, Wallet, Results, and Settings.
  - **Notifications:** `NotificationBell` with unread count badge and `_NotificationPanel` triage modal.
- **Desktop & Cross-Platform Support:**
  - Resolved C++ build settings in `app/linux/CMakeLists.txt` for native Linux Desktop builds (`flutter run -d linux`).
  - Verified static analysis (`flutter analyze`) with zero errors across all screens and providers.

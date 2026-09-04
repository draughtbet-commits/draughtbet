# Draughts Arena — Project Progress & State

**Last Updated:** October 2026

## ⏳ Current Status: Week 10 (Admin Backend)

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

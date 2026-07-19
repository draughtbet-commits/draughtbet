# 04 — Frontend Specification (Flutter)

Stack: Flutter, Riverpod, go_router, Dio, socket_io_client. See `05_DESIGN_SYSTEM_DNA.md` for every visual detail referenced below — this file covers structure and behavior, not appearance.

## Packages

`flutter_riverpod dio socket_io_client flutter_secure_storage go_router freezed_annotation json_annotation webview_flutter firebase_messaging firebase_core flutter_dotenv device_info_plus package_info_plus connectivity_plus intl google_fonts lucide_icons flutter_local_notifications`
Dev: `build_runner freezed json_serializable mocktail`

**No `flutter_stripe` for the Phase 1 (Nigeria) build.** Paystack and Flutterwave don't have official first-party Flutter SDKs as clean as Stripe's — the standard, reliable pattern is to open their hosted checkout page in a `webview_flutter` view using the `authorizationUrl` returned by `POST /wallet/deposit-intent` (see `03_BACKEND_SPEC.md`), then detect the redirect/callback URL to know the payment finished and poll or wait on the webhook-driven `wallet_updated` socket event to confirm. `flutter_stripe` gets added when the Phase 2 GBP/global expansion happens.

## Folder structure

```
lib/
  theme/          colors.dart, typography.dart, theme.dart, tier_theme.dart (see 05_DESIGN_SYSTEM_DNA.md §10)
  screens/
  widgets/
  providers/       Riverpod providers — one file per domain (auth, wallet, match, callout, notifications)
  models/           freezed data classes matching 02_DATABASE_SCHEMA.md shapes
  services/         Dio client, socket client, secure storage wrapper
  router/           go_router route table
```

## Routing (go_router)

`/login`, `/register`, `/home`, `/tier-select`, `/match/:id`, `/wallet`, `/results`, `/settings`. Redirect logic: unauthenticated users bounced to `/login` before any protected route renders (checked at the router's `redirect` callback, not per-screen).

## Screens

### Login / Register
- Login: email/password, show/hide toggle, inline error states, loading spinner.
- Register: email, password + strength indicator, confirm password, date-of-birth picker (client-side 18+ check as a UX courtesy — the server is still the authority per `00_MASTER_PROMPT.md` §3), terms checkbox.
- Both wired to `authProvider` (Riverpod) exposing `login()` / `register()` / `logout()`.
- JWT stored via `flutter_secure_storage` only — never `shared_preferences`.

### Home
Matches the wireframe zones exactly (see `01_PRODUCT_CONTEXT.md`):
- Top-left: notification bell (unread badge)
- Top-center: wallet balance chip (see `05_DESIGN_SYSTEM_DNA.md` §6)
- Top-right: settings icon
- Mid-screen: tier cards (Amateur/Master/Pro) with stake ranges pulled from `GET /wallet/tier-limits` — never hardcoded client-side
- Bottom nav: Home, Wallet, Results, Settings

### Tier select → Matchmaking
- Selecting a tier shows: "Find a match" (joins Redis matchmaking queue via backend, shows searching state, navigates to `/match/:id` on `match_found`) and a call-out browse list (open call-outs this tier is eligible to accept, per `GET /callouts/open`).
- Amateur tier: no call-out browse/create UI shown at all (per `01_PRODUCT_CONTEXT.md` — Amateur is not eligible).
- Call-out creation: stake-amount dialog (clamped client-side to tier bounds, server re-validates regardless), submits to `POST /callouts`.
- Incoming call-out: notification banner with accept/decline, wired to `POST /callouts/:id/accept`.

### Match screen
- `CustomPainter`-rendered 10×10 board — see `05_DESIGN_SYSTEM_DNA.md` §6 for exact colors/motion.
- Tap piece → highlight legal destination squares (fetched with the move state, never precomputed client-side independently of what the server confirms) → tap destination → emit `move_attempt` via `socket_io_client`.
- Listen for `move_applied` / `move_rejected` / `match_ended`; repaint accordingly.
- Reconnect: on `connectivity_plus` detecting reconnect, call `GET /matches/:id/state` to resync before trusting further socket events.
- Win/loss banner overlay on `match_ended` — see design doc for exact treatment.

### Wallet
- Balance (₦), deposit button — shows a Paystack/Flutterwave choice, then opens the returned `authorizationUrl` in a `webview_flutter` view (see §Packages), withdrawal request form, paginated transaction history list.
- Balance updates live via the `wallet_updated` socket event once the webhook confirms payment — not polling, and not trusting the webview's own redirect alone as proof of payment.

### Results
- Match history log — per the wireframe's "logs results of previous games" feature. List view, tap to see summary (winner, stake, date) — full move-by-move replay is explicitly out of MVP scope (`01_PRODUCT_CONTEXT.md`).

### Settings
- Account settings, notification preferences, log out, legal pages (terms, privacy policy — required before Play Store submission per `06_BUILD_SEQUENCE.md`).

### Notifications panel
- Bell icon dropdown/panel: last 10 notifications, mark-all-read, tap navigates to the relevant screen (e.g., a `MATCH_ENDED_WIN` notification opens `/results`).
- `firebase_messaging` background handler registered at app start; FCM token sent to backend (`fcmToken` field) on login.
- **Android Foreground Banners**: Because FCM on Android suppresses heads-up banner notifications while the app is in the foreground, `flutter_local_notifications` must be used to manually trigger a local banner when a foreground FCM message is received.

## State management conventions

- One Riverpod provider file per domain — `authProvider`, `walletProvider`, `matchProvider`, `calloutProvider`, `notificationProvider`.
- Providers own their Dio/socket calls; screens are thin and only read/watch provider state — don't put network calls directly in widget code.
- `freezed` models mirror the Prisma schema shapes from `02_DATABASE_SCHEMA.md` field-for-field, so a backend response can be deserialized without ad-hoc mapping.

## Network layer

- `Dio` client wrapper with an auth interceptor: attaches the JWT access token to every request, catches 401s, calls `/auth/refresh`, retries the original request once with the new token.
- `socket_io_client` connection established once at app start (after login), reused across screens — not reconnected per-screen.

## Non-negotiables (repeated from `00_MASTER_PROMPT.md` because they matter most here)

- The app never sends a resulting balance or a "this move is legal" claim to the server — only requests actions.
- Every screen's colors, spacing, and type must come from `lib/theme/` (see `05_DESIGN_SYSTEM_DNA.md` §10) — no inline hex values or magic-number padding in widget code.

# Domain / URL integration checklist

Audit date: 2026-10-15. Scope: every place in the repo (backend, Flutter app,
docs, database) that refers to a URL, origin, host, or other thing a real domain
must be configured for, so the platform can be integrated into production.

## Summary of the database audit

The database stores **no domains**. The only configuration tables were checked
directly against the live database (`draughts_arena`):

- `PlatformSettings` (singleton row) — numeric policy only: commission, stake
  and call-out bounds, time control, deposit gateway enable flags, fees,
  deposit min/max, quote TTL. No URL column.
- `PlatformConfigVersion` (`v1`) — JSON snapshot of the same numeric policy
  (`proStakeMaxP`, `commissionPercent`, `timeControlSeconds`,
  `limitRaiseCoolingHours`, …). No URL value.
- No schema model has a domain/origin/base-URL field. The only URL-ish columns
  are per-row data, not config: `DepositIntent.authorizationUrl` (the provider's
  hosted checkout link), `DisputeEvidence.url` (storage path), and
  `Notification.link` (app-relative routes such as `/wallet`, `/results`).
- `KycDocument.objectKey` is a private storage reference (provider-hosted
  storage preferred), not a public URL.

So every domain-bearing item lives in **environment variables**, **external
provider dashboards**, or **app-side configuration** — not in the database.

Intended domain shape (documented in
`docs/backend-handoffs/2026-09-18-security-hardening.md:38-40`):
`draughtbet.com`, with the admin SPA at `https://admin.draughtbet.com`.

---

## 1. Public API host (the app's backend URL)

| Item | Location | Dev value today | Production value |
|---|---|---|---|
| `BACKEND_URL` | `app/.env` | `http://127.0.0.1:3200/api/v1` | `https://api.draughtbet.com/api/v1` |
| `BACKEND_CONTRACT` | `app/.env` | `v2` | `v2` |

Fallbacks that must not ship as-is:

- `app/lib/services/token_refresher.dart:29` — `http://10.0.2.2:3200/api/v1`
- `app/lib/services/token_refresher.dart:47` — `http://localhost:3000`
- `app/lib/services/api_client.dart:39` — `http://localhost:3000`
- `app/lib/services/socket_service.dart:401` — `http://localhost:3000`

Integration step: decide the canonical API hostname (e.g.
`api.draughtbet.com`), point `app/.env` at it, and remove or gate the
localhost fallbacks behind a debug assertion so a release build cannot fall
back to them.

## 2. Webhook endpoints (public HTTPS — the money path)

Mounted at `backend/src/app.js:86-87`, routed as:

| Endpoint | Registration required in |
|---|---|
| `POST https://<host>/webhooks/paystack` | Paystack dashboard (test and live are separate) |
| `POST https://<host>/webhooks/flutterwave` | Flutterwave dashboard (test and live are separate) |
| `POST https://<host>/webhooks/dojah` | Dojah: `POST {DOJAH_BASE_URL}/api/v1/webhook/subscribe` with `{"webhook":"https://<host>/webhooks/dojah","service":"kyc_widget"}` |

Notes:

- Deposits credit **only** on webhook — it is the single point of failure for
  "the player's money arrived" (`docs/backend-handoffs/2026-09-27-deposit-production-readiness.md:89-105`).
- Per-environment webhook URLs and secrets are mandatory; test and live keys do
  not share them (`.../2026-09-27-deposit-production-readiness.md:95-96`, `:144`).
- Webhooks are mounted before `express.json()` and before the global rate
  limiter (raw body needed for HMAC), and are exempt from the global limiter —
  no app change needed, only DNS/TLS in front.

## 3. Admin dashboard origin (CORS)

| Item | Location | Dev value | Production |
|---|---|---|---|
| `ADMIN_CORS_ORIGIN` | `backend/src/app.js:61-63`, `backend/src/sockets/index.js:11` | `http://localhost:5173` | `https://admin.draughtbet.com` |

- **Required in production** — the backend throws at boot if unset when
  `NODE_ENV=production` (refuses open CORS). With it set, CORS echoes only that
  exact request origin.
- The admin SPA itself is not in this repo; it must be deployed and CORS-matched.
- Also required for the socket handshake (`sockets/index.js:11`).

## 4. TLS / reverse proxy

| Item | Location | Value |
|---|---|---|
| `APP_ENFORCE_TLS` | `backend/src/app.js:74-82` | `true` in production — GET/HEAD 301→HTTPS, non-idempotent 403, `/health` and `/ready` exempt |
| `TRUST_PROXY` | `backend/src/app.js:49-51` | hop count behind the load balancer (defaults to `1` in production) |
| `ADMIN_MFA_SECRET_KEY` | boot guard (PR13) | 64-char hex AES key; required in production |

## 5. Payment gateways (domains to change in code + dashboards)

### Flutterwave — hardcoded placeholder redirect

- `backend/src/modules/payment/FlutterwaveGateway.js:62`:
  `redirect_url: 'https://placeholder.uplix.com/payment/callback'`
- This is a **placeholder left in code**. It needs the real public return URL
  and should be read from an env var (e.g. `FLUTTERWAVE_REDIRECT_URL`)
  rather than hardcoded.

### Paystack — missing callback entirely

- `backend/src/modules/payment/PaystackGateway.js:52-89`
  (`initiatePayment`) sends no `callback_url`, so after a 3-D Secure redirect
  the player lands on a dead end. Documented as P2 with fix direction:
  `docs/backend-handoffs/2026-09-27-deposit-production-readiness.md:75-82`.

### Gateway API bases

| Item | Default | Note |
|---|---|---|
| `PAYSTACK_API_BASE` | `https://api.paystack.co` (`PaystackGateway.js:14`) | must be production in a deployed build |
| `FLUTTERWAVE_API_BASE` | `https://api.flutterwave.com` (`FlutterwaveGateway.js:14`) | must not be left pointing at a local double (`http://10.0.2.2:4010`) |

Secrets per environment: `PAYSTACK_SECRET_KEY` (`sk_test_`/`sk_live_`),
`FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`
(`.../2026-09-27-deposit-production-readiness.md:116-126`).

## 6. Email (OTP delivery + password reset)

Delivery providers are selected from `OTP_DELIVERY`
(`backend/src/modules/auth/deliveryProvider.js:143-153`):

| Item | Location | Value |
|---|---|---|
| `OTP_DELIVERY` | `backend/src/modules/auth/deliveryProvider.js` | `email` in production (unset/unknown fails closed → OTP endpoints 503) |
| `EMAIL_API_URL` | `deliveryProvider.js:58` | e.g. `https://api.resend.com/emails` |
| `EMAIL_API_KEY` | `deliveryProvider.js:58` | provider key |
| `EMAIL_FROM` | `deliveryProvider.js:58` | e.g. `Draught Bet <no-reply@draughtbet.com>` |

Supporting domain work: DNS for the sending domain — SPF, DKIM, DMARC —
otherwise OTP and password-reset mail lands in spam or is rejected.

Note: `reset-password`/`verify` flows do **not** embed links today (the code is
typed into the app), so no reset deep-link URL is required — only the sender
domain.

## 7. KYC provider (Dojah)

| Item | Location | Value |
|---|---|---|
| `DOJAH_BASE_URL` | `backend/src/modules/verification/providerAdapter.js:84` | `https://sandbox.dojah.io` → `https://api.dojah.io` in production |
| `DOJAH_APP_ID`, `DOJAH_SECRET_KEY`, `DOJAH_WIDGET_ID` | `providerAdapter.js:82` | console values |
| `KYC_PROVIDER` | env | `simulated` → `dojah` (`simulated` refused outright in production) |

- The widget is hosted by Dojah; results arrive on `POST /webhooks/dojah`
  (HMAC-SHA256 over raw body) — register the public webhook URL as in §2.
- KYC document storage is open work: `KycDocument.objectKey` points at private
  storage ("provider-hosted preferred") with no bucket/CDN configured yet
  (`prisma/schema.prisma:1255`; also listed as open in the PR13 audit).

## 8. Push notifications (Firebase / FCM)

Status: **declared but not integrated**.

- App: `firebase_messaging` and `firebase_core` in `app/pubspec.yaml`, but no
  `google-services.json` (Android) / `GoogleService-Info.plist` (iOS) and no
  `firebase_options.dart`.
- Backend: `PUSH_TOKEN_ENCRYPTION_KEY` **is** wired —
  `backend/src/modules/me/pushTokenService.js:23` encrypts tokens on register
  (32-byte hex required), but **no code sends FCM messages**, and
  `FIREBASE_SERVICE_ACCOUNT_KEY` (present in `.env`/`.env.example`) is not read
  anywhere in `backend/src`.
- Integration: create the Firebase project, register Android package
  `com.draughtbet.draughts_arena` (+ release SHA-1), add the service-account
  key, implement the sender, set `PUSH_TOKEN_ENCRYPTION_KEY`.

## 9. Reverse geocoder

| Item | Location | Value |
|---|---|---|
| `REVERSE_GEOCODER_URL` | `backend/src/services/geoService.js:17-18` | default already `https://nominatim.openstreetmap.org/reverse` |

No domain to own, but it is a third-party endpoint with a usage policy (custom
User-Agent, rate limits); self-hosting it behind your own host is the
production-grade option.

## 10. App deep links

| Item | Location | Status |
|---|---|---|
| Custom scheme `draughts://app` | `app/android/app/src/main/AndroidManifest.xml:44-49` | declared, needs no domain |
| Dart-side handling | `app/lib/` | **none** — no `app_links`/`uni_links`, no `getInitialLink`, no router handling. Opens the app but cannot route to a target screen |
| https App Links / Universal Links | — | not configured (no `autoVerify`, no `http(s)` scheme) |

To make shareable links work end-to-end:

1. Choose a short-link host (e.g. `draughtbet.com/join/…`).
2. Android: add `https` intent-filter with `android:autoVerify="true"` and host
   `/\.well-known/assetlinks.json` on the domain (signed with the app's
   release SHA-1).
3. iOS: host `/apple-app-site-association`.
4. Add `app_links` in Dart and map initial/terminated URIs onto the router
   (the router already accepts `/matches/<id>/join`-style API paths, so a URL
   → route mapping is straightforward).

## 11. Third-party sign-in (currently a stub)

"Continue with Google" is rendered on the login screen
(`app/lib/screens/login_screen.dart:293-300`) but is UI-only: no
`google_sign_in` package, no backend token-verification endpoint, no OAuth
client IDs. If enabled it needs: Google Cloud OAuth clients (Android + Web),
authorized JavaScript origins / redirect URIs for the domain, and the Android
SHA-1 fingerprint.

## 12. Store compliance URLs (not present in code)

No privacy policy or terms-of-service URL exists anywhere in the app (searched
`app/lib` for privacy/terms/policy — only game "terms" matches). Play Store
and App Store listings require hosted, reachable pages, e.g.:

- `https://draughtbet.com/privacy`
- `https://draughtbet.com/terms`

Consent capture is stored per-account (`ConsentRecord` table) but no document
URL is shown or recorded.

---

## Consolidated env set for a production domain

```dotenv
# --- public host ---
# app/.env
BACKEND_URL=https://api.draughtbet.com/api/v1

# --- backend ---
NODE_ENV=production
TRUST_PROXY=1
APP_ENFORCE_TLS=true
ADMIN_CORS_ORIGIN=https://admin.draughtbet.com
ADMIN_MFA_SECRET_KEY=<64-hex>
ADMIN_MFA_ENFORCED=true

# --- payments (per environment; keep test and live apart) ---
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_API_BASE=https://api.paystack.co
FLUTTERWAVE_SECRET_KEY=FLWSECK_LIVE-...
FLUTTERWAVE_SECRET_HASH=<hash>
FLUTTERWAVE_API_BASE=https://api.flutterwave.com
FLUTTERWAVE_REDIRECT_URL=https://draughtbet.com/payment/callback   # NEW — replaces placeholder at FlutterwaveGateway.js:62

# --- email ---
OTP_DELIVERY=email
EMAIL_API_URL=https://api.resend.com/emails
EMAIL_API_KEY=re_...
EMAIL_FROM=Draught Bet <no-reply@draughtbet.com>

# --- kyc ---
KYC_PROVIDER=dojah
DOJAH_BASE_URL=https://api.dojah.io
DOJAH_APP_ID=...
DOJAH_SECRET_KEY=...
DOJAH_WIDGET_ID=...

# --- push ---
FIREBASE_SERVICE_ACCOUNT_KEY={...}   # currently unread by backend code
PUSH_TOKEN_ENCRYPTION_KEY=<32-byte hex>

# --- optional ---
REVERSE_GEOCODER_URL=https://nominatim.openstreetmap.org/reverse
MIN_APP_VERSION=<floor>   # or SUPPORTED_APP_VERSIONS=<allowlist>
```

## Code changes implied by this audit

1. `FlutterwaveGateway.js:62` — env-var the redirect URL (placeholder domain today).
2. `PaystackGateway.js:initiatePayment` — add a `callback_url` from env
   (P2 in the deposit production-readiness handoff).
3. `app/lib` — localhost fallbacks (`token_refresher.dart:29/47`,
   `api_client.dart:39`, `socket_service.dart:401`) must not survive in release.
4. Deep-link handling in Dart (if https links are wanted) + assetlinks/AASA.
5. FCM sender on the backend (tokens are already encrypted on store).
6. Privacy/terms pages linked from the app.

## Source references

- `docs/backend-handoffs/2026-09-27-deposit-production-readiness.md` — webhook/callback rollout, gateway API bases.
- `docs/backend-handoffs/2026-09-18-security-hardening.md:32-42` — operator env vars (CORS, TLS, MFA).
- `docs/backend-handoffs/2026-09-18-kyc-eligibility-safer-play.md` — KYC provider wiring.
- `backend/.env.example` — the documented env surface.
- `backend/src/app.js:46-89` — trust proxy, CORS, TLS enforcement, webhook mounts.

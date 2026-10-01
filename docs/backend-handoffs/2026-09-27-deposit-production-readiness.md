# Deposit production readiness: what must change before live keys

Date: 2026-09-27
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: backend / payments / Flutter wallet
Scope: PR6 deposit flow — quote, intent, hosted checkout, webhook credit
Status: **verified against a local provider double only. No real gateway has been exercised.**

## Where card details are entered

The app never collects card data, and that is deliberate. A real deposit runs:

1. `Add money` — player enters an amount, the app requests a server quote.
2. `Payment method` — the app renders the server-owned method catalogue
   (Paystack, Flutterwave). The app never hardcodes methods.
3. `Hosted checkout` — `Pay now` pushes `CheckoutWebviewScreen` with the
   `authorization_url` returned by the gateway.
4. **The provider's hosted page is where the player types card number,
   expiry, CVV, chooses the card brand, and clears 3-D Secure / OTP.**
5. The provider calls our webhook. The server credits the wallet.
6. The app polls the deposit status and shows `DEPOSIT SUCCESSFUL`.

Nothing sensitive is posted to this backend and no gateway secret ships in
the app binary. Because we drive Paystack through `authorization_url` rather
than an inline card form, the platform stays in hosted-checkout PCI scope
(SAQ-A). **Do not add card fields to the app** — that would pull the whole
platform into full PCI DSS scope.

## Blocking issues before live keys

### P1 — The confirmation window is 31 seconds

`app/lib/providers/deposit_provider.dart:65` backoffs are 1, 2, 4, 8, 16
seconds, and polling stops once the attempt count is exhausted
(`deposit_provider.dart:245`). Total coverage: **31 seconds**.

Real card payments clear 3-D Secure with an OTP prompt, which routinely takes
30–120 seconds. Bank transfers can take hours to days. In all of those cases
the webhook still credits the wallet — **the money is never lost** — but the
app stops checking and displays `PENDING` indefinitely.

Realistic failure mode: the player pays, waits, sees no confirmation, and
does not know whether the money arrived. The pending screen's
`Do not make another payment while confirmation is pending.` is the only
thing preventing a double spend, and it is load-bearing.

It self-heals on next launch, because the intent reference is persisted and
recovered. That is not good enough for a live payment flow.

Fix direction: a much longer backoff, and keep polling while the status
screen is open, or subscribe to a push/stream rather than polling. A local
double that confirms in milliseconds is what tuned this number; a bank did
not.

### P1 — The hosted checkout page has never been seen rendering

The emulator in use ships `com.android.webview 83.0.4103.120` (a 2020
build). Its renderer crashes on load, so the provider page renders as a blank
screen and the page is never even fetched. `CheckoutWebviewScreen` now
reports a main-document load failure with a retry, which turns a silent black
screen into an honest error — but an error is still not a payment.

Most real devices update WebView through the Play Store, so this is
primarily a test-fleet and old-device problem rather than a universal one. It
still needs a decision before launch:

- confirm a supported minimum WebView version and test against a current
  emulator image
- `webview_flutter` is on 4.7; check whether a newer `webview` package
  supports current WebViews more reliably
- decide the behaviour on a device that cannot render checkout at all

### P2 — No `callback_url` is sent to the gateway

`backend/src/modules/payment/PaystackGateway.js` initializes the transaction
without a `callback_url`. After a 3-D Secure redirect there is nowhere for the
provider to return the player to, so they land on a dead end and have to find
the close control. The webhook still credits them, so it is recoverable, but
it reads as a failure at exactly the moment the player is most anxious.

Fix direction: send a `callback_url`, and state on the checkout screen that
the wallet updates on webhook confirmation and the page can be closed.

Related: `CheckoutWebviewScreen`'s `onNavigationRequest` returns `navigate`
for every URL. That is intentional — providers bounce through several domains
during 3-D Secure — but it does mean the webview will follow a redirect
anywhere.

### P2 — Webhook reliability is the only path that moves money

Credit happens exclusively on webhook, so webhook delivery is the single
point of failure for "the player's money arrived". Required:

- a public HTTPS endpoint, with `charge.success` and `charge.failed` handled
- per-environment webhook URLs and secrets configured in the provider
  dashboard; test and live keys do not share them
- **idempotency.** The provider retries, and a double-delivered event must
  not double-credit. This is the same discipline already applied to payouts
  in `fe7c6a2`.
- **reconciliation.** We cannot rely on the player reopening the app. Some
  sweep must query the provider for unconfirmed intents. The payouts flow
  already has an "asked the provider, outcome unknown" state and a follow-up
  sweep; deposits need equivalent treatment.
- respond 2xx quickly or the provider retries

### P2 — Bank transfer is a different lifecycle

Bank transfer is not a short 3-D Secure hop. The transfer reference must be
polled and confirmation can take hours or days, so `PENDING` is legitimately
long-lived. The method tile should say so before the player commits, and the
status screen should not imply a short wait. `PROCESSING` is withdrawal-only
in the deposit contract — deposits are `PENDING` / `COMPLETED` / `FAILED`.

## Real rollout checklist

- `PAYSTACK_SECRET_KEY` and `FLUTTERWAVE_SECRET_KEY` per environment. Paystack
  exposes `sk_test_` / `sk_live_`. The app needs **no** public key, because
  hosted checkout is driven by `authorization_url`.
- `PAYSTACK_API_BASE` / `FLUTTERWAVE_API_BASE` must point at production. Both
  are overridable today precisely so a local double can be substituted; make
  sure they are not left pointing at `http://10.0.2.2:4010` in a deployed
  build.
- **Flutterwave is not a copy-paste of Paystack.** Its flow goes through a
  `charge` endpoint returning a `redirect_url`, and it typically requires a
  `public_key` in the payload. The app-side model is identical, but the
  gateway implementation is not.
- Enable the real method catalogue server-side. The app renders whatever the
  server returns.
- Decide the disposition of a charged-but-`PENDING` intent. That is a support
  path, and it will happen.

## How to actually test card entry

Not with `backend/scripts/fake-paystack.mjs`. The double proves the app's
plumbing — quote, intent, webhook signature, status polling — and nothing
else. It deliberately has no card form, because typing a fabricated card
number proves nothing about a real gateway.

To exercise the real hosted page, the 3-D Secure redirect, and a genuinely
signed webhook, point the app at the provider's **test keys** and use their
documented test card. Paystack's published test card is
`408408 4080 4080 4081` with any future expiry, any CVV, and OTP `123456` —
**confirm these against the provider's current documentation before relying
on them**, and keep test-mode and live-mode webhook URLs separate.

## Deliberate decisions to keep

- **Deposits are fee-free.** The quote is 0 bps and the backend fails closed
  if a non-zero fee is ever configured, because the credit path does not
  collect one. The app shows Amount and Total only. Note this is a business
  decision, not just configuration: the provider's transaction fee, and the
  chargeback exposure on international cards, are absorbed by the platform.
- **The server owns the quote and the fee.** The app never invents a fee.
- **A provider URL is never treated as payment success.** The app only ever
  reports what the API says about the deposit.

## What is verified today

Against the real backend with a local provider double:

- all six drive steps pass — `add-money`, `methods`, `checkout`, `webview`,
  `pending`, `successful`
- the happy path is genuinely end to end: real quote, real intent, signed
  webhook, `COMPLETED` intent, `DEPOSIT SUCCESSFUL` in the app
- 228 app tests, 33 payment tests, analyze clean apart from one pre-existing
  warning

Two defects found by that drive were fixed in `80d23a4`: confirmation polling
was killed on arrival by the status screen's own `initState`, and the
hosted checkout had no error handling at all. Neither was reachable by unit
test.

# 06 — Build Sequence

Week-by-week build order, Jul 10 – Oct 31 2026. Each week references `02_DATABASE_SCHEMA.md`, `03_BACKEND_SPEC.md`, and `04_FRONTEND_SPEC.md` rather than repeating their content — this file is the checklist and the order, not the spec itself.

## Week 1 (Jul 10–16) — Infrastructure & database foundation
- [x] Research + document Google Play real-money skill-game policy specifically for the Nigeria market
- [x] Confirm with Paystack and Flutterwave directly that their merchant terms permit real-money skill-gaming payouts (both, since Flutterwave is the redundancy gateway — a rejection on either changes the wallet design)
- [x] Research Nigeria-specific regulatory exposure (state lottery boards, National Lottery Regulatory Commission, CBN wallet-licensing risk) — see `01_PRODUCT_CONTEXT.md` Regulatory note
- [x] Mr. Livingstone's written confirmation of the NGN/Paystack/Flutterwave change — settled, see `01_PRODUCT_CONTEXT.md`
- [ ] Repo, CI (lint + Jest on push), Contabo VPS provisioning (Ubuntu 24, Node 24, Postgres 15, Redis 7, Nginx, PM2, UFW, fail2ban)
- [ ] Sentry + UptimeRobot set up, `GET /health` live
- [ ] Full Prisma schema from `02_DATABASE_SCHEMA.md` migrated to a local/staging Postgres
- [ ] Flutter project scaffold, folder structure, `go_router` table stubbed per `04_FRONTEND_SPEC.md`

## Week 2 (Jul 17–23) — Authentication
- [ ] All `/auth/*` endpoints from `03_BACKEND_SPEC.md` built and tested
- [ ] Login/register screens from `04_FRONTEND_SPEC.md`, styled per `05_DESIGN_SYSTEM_DNA.md`
- [ ] Rate limiting + CORS + helmet configured

## Week 3 (Jul 24–30) — Game engine core
- [ ] `src/modules/engine/` built as a pure module — no DB/socket imports
- [ ] All 7 required Jest fixtures from `03_BACKEND_SPEC.md` green before moving to Week 4
- [ ] Flutter: static board rendering scaffold only (visual, not yet wired)

## Week 4 (Jul 31–Aug 6) — Real-time integration
- [ ] Socket.IO events wired per `03_BACKEND_SPEC.md`
- [ ] Disconnect/grace-period/auto-forfeit cron job
- [ ] Flutter board fully wired to sockets, reconnect resync via `GET /matches/:id/state`
- [ ] **Demo checkpoint:** two accounts play a full rules-correct game in real time

## Week 5 (Aug 7–13) — Matchmaking & call-outs
- [ ] Redis matchmaking queues + worker, call-out endpoints, tier enforcement middleware
- [ ] Flutter tier-select, matchmaking, call-out browse/create/accept screens

## Week 6 (Aug 14–20) — Wallet & payment gateway backend
- [ ] Payment gateway abstraction (`PaymentGateway` interface), `PaystackGateway` + `FlutterwaveGateway` implementations, both webhook endpoints, withdrawal-request, atomic stake/payout logic — all per `03_BACKEND_SPEC.md`

## Week 7 (Aug 21–27) — Wallet UI + tier enforcement checkpoint
- [ ] Flutter wallet screen (₦ balance, `webview_flutter` checkout flow per `04_FRONTEND_SPEC.md`), tier stake clamping, `GET /wallet/tier-limits` wired
- [ ] **Demo checkpoint (Milestone 2 — invoice trigger):** real sandbox deposit via Paystack or Flutterwave, matched/call-out play at correct NGN stakes, payout minus commission, withdrawal request visible for admin review

## Week 8 (Aug 28–Sep 3) — Notifications
- [ ] `NotificationService` + all 8 triggers from `03_BACKEND_SPEC.md`, FCM push wired
- [ ] Flutter notification bell + panel

## Week 9 (Sep 4–10) — Security & anti-cheat
- [ ] Device fingerprinting, IP anomaly logging, server-side re-validation audit of every socket handler
- [ ] Additional engine Jest fixtures for any edge case found during real play this week

## Week 10 (Sep 11–17) — Admin backend
- [ ] All `/admin/*` endpoints from `03_BACKEND_SPEC.md`, every mutation writing `AdminAuditLog`

## Week 11 (Sep 18–24) — Admin frontend (React)
- [ ] Vite + Tailwind admin dashboard: overview, users, withdrawals, live matches, revenue, settings, disputes
- [ ] **Demo checkpoint:** client independently approves a withdrawal and adjusts commission rate

## Week 12 (Sep 25–Oct 1) — QA part 1: load & engine hardening
- [ ] `k6` concurrent-match load test, Socket.IO/Prisma pool tuning
- [ ] Real physical-device disconnect testing
- [ ] Basic OWASP ZAP pass

## Week 13 (Oct 2–8) — QA part 2: UI polish & sign-off
- [ ] Full UI pass matching `05_DESIGN_SYSTEM_DNA.md` exactly
- [ ] Full end-to-end scenario test under load
- [ ] **Demo checkpoint (client sign-off):** live session, client tries to break it — any bug found here is blocking

## Week 14 (Oct 9–15) — Store submission prep
- [ ] Age gate re-verified server-side, privacy policy + ToS published, geo-restriction enforced to Nigeria only for this launch
- [ ] Store listing assets from real builds, not mockups
- [ ] Paystack and Flutterwave live-mode dry run (both gateways, since either could be the one a given user's card routes through)

## Week 15 (Oct 16–22) — Submission & review buffer
- [ ] Submit to Google Play, absorb at least one review/resubmit cycle

## Week 16 (Oct 23–31) — Buffer, handover, launch
- [ ] Fix review feedback, production deploy (Nginx WebSocket upgrade headers configured correctly)
- [ ] Handover package: this document set + third-party library list + admin walkthrough
- [ ] Final milestone invoiced, launch

## Post-launch (Week 17+, explicitly out of MVP)
Leaderboards, full move-replay UI, spectator mode, in-app chat, referral programme, tournaments, cosmetic purchases, iOS build, "watch ads to unlock activities" — all quoted and billed separately per Contract §12.2 (see `01_PRODUCT_CONTEXT.md`).
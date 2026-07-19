# Draughts Arena — Comprehensive Project Analysis (Updated)

This document synthesizes the findings from the updated `Draught bet` project specification files, providing a high-level overview of the product, architecture, design system, and roadmap.

## 1. Project Overview & Pivot

**Draughts Arena** is a real-money, skill-based mobile gaming platform centered around International Draughts (10x10 board).
- **Client:** Mr. Livingstone (UK)+
- **Developer:** Edudje Wisdom, Uplix (Nigeria)
- **Target Market & Platforms:** Nigeria-first for MVP (Phase 1), with global expansion deferred to Phase 2. Android-only.
- **Currency & Gateways:** The platform uses **NGN (₦)** via **Paystack (primary)** and **Flutterwave (secondary)** for Phase 1. GBP and Stripe are explicitly deferred to Phase 2.
- **Core Philosophy:** "Serious strategy arena, real stakes, fair and secure." The server is the absolute authority on all game and financial states.

## 2. Gameplay & Matchmaking Constraints

### Game Rules
- 10x10 International Draughts board.
- **Mandatory & Maximum Capture:** Players must take a capture if available, and must choose the path that captures the most pieces.
- Multi-jump chains and "flying kings" (long-range diagonal movement/captures) are enforced.
- **Draws:** Threefold repetition, 25-consecutive-king-moves, or by agreement (only after 40 moves per player).

### Tiers & Stakes (NGN)
> [!IMPORTANT]  
> There is a strict distinction between normal matchmaking bounds and call-out ceilings. The tier-enforcement middleware must validate these against separate fields in `PlatformSettings`.

- **Amateur:** 
  - Normal Matchmaking: ₦500 – ₦15,000
  - Call-out Eligibility: **None** (Learners)
- **Master:** 
  - Normal Matchmaking: ₦10,000 – ₦30,000
  - Call-out Ceiling: **Up to ₦150,000**
- **Pro:** 
  - Normal Matchmaking: ₦30,000 – ₦60,000
  - Call-out Ceiling: **Up to ₦300,000**

## 3. Architecture & Tech Stack

### Backend
- **Core:** Node.js, Express, Prisma (PostgreSQL 15+), Redis (ioredis), Socket.IO.
- **Game Engine:** (`src/modules/engine/`) Built as a **pure module** with no DB or network imports. Must be thoroughly tested with Jest before integrating with the app.
- **Wallet & Transactions:** All financial operations must happen atomically within a single Prisma `$transaction`. Money is stored strictly as `BigInt` minor units (e.g., kobo for NGN). All occurrences of `stakePence` have been normalized to `stakeMinorUnits`.
- **Payment Abstraction:** The backend introduces a `PaymentGateway` interface from day one to support `PaystackGateway` and `FlutterwaveGateway`, making the future addition of `StripeGateway` seamless.
- **Matchmaking:** Handled via Redis sorted sets and processed via a `node-cron` worker every 3 seconds.

### Real-Time Infrastructure (Socket.IO & Redis)
- **Redis Persistence:** **Redis AOF (Append Only File) persistence must be enabled.** Active matches and stakes exist in memory; volatile keys cannot be lost on a restart.
- **Performance:** Move round-trip latency (client `move_attempt` → both clients receive `move_applied`) is targeted to be **under 100ms**.

### Frontend (Flutter)
- **Core:** Flutter, Riverpod, go_router, Dio, socket_io_client, webview_flutter.
- **Behavior:** The app renders state and sends actions; it **never** determines game logic or calculates wallet balances locally.
- **Payments:** Replaces native SDKs with a `webview_flutter` flow that opens the Paystack/Flutterwave hosted checkout pages, relying on the `wallet_updated` socket event to confirm the transaction.

### Admin Dashboard
- **Core:** React, Vite, Tailwind CSS.
- **Features:** User management, withdrawal approvals, live match monitoring, and revenue analytics.

## 4. Design System & Aesthetics

> [!IMPORTANT]
> The UI must convey a premium, high-stakes environment. No cartoon mascots, confetti animations, or gambling-adjacent tropes.

- **Color Palette:** Dark-mode first (`void` background #0B0D10). Minimal semantic colors: Gold (`#E7B24A`) is the signature color, used sparingly (e.g., for Pro tier or winning moments).
- **Signature Motif:** "The Crossing" — a single thin gold diagonal stroke symbolizing a draughts capture, used only in high-value contexts.
- **Typography:**
  - *Fraunces* for display text to signal heritage and prestige.
  - *Manrope* for general UI reading text.
  - *JetBrains Mono* (tabular figures) for all financial balances, stakes, and timers to prevent visual jitter.

## 5. Development Roadmap (16 Weeks)

The project is structured into a strict 16-week timeline starting July 10, 2026:
- **Weeks 1-2:** Infrastructure, DB Schema setup (NGN/Kobo support), and Auth (JWT/Redis).
- **Week 3:** Game Engine core (pure logic, heavily tested).
- **Week 4:** Real-time integration (Socket.IO + Playable board).
- **Week 5:** Matchmaking & Call-outs logic.
- **Weeks 6-7:** Dual Payment Gateway integration (Paystack/Flutterwave) and Wallet UI (`webview_flutter`).
- **Week 8:** Push and In-app notifications.
- **Week 9:** Security & Anti-Cheat (Device fingerprinting, rate limiting).
- **Weeks 10-11:** Admin Dashboard Backend & Frontend (React).
- **Weeks 12-13:** Quality Assurance, Load testing, UI polish, E2E client sign-off.
- **Weeks 14-16:** Store submission prep (Nigeria Geo-fence), review buffer, and launch.

## 6. Critical Security & Engineering Rules
1. **Never trust the client:** The frontend requests moves; the server verifies legality.
2. **Atomicity:** A debit and credit must exist inside the same Prisma transaction.
3. **No automatic withdrawals:** Admin review is required by design.
4. **Audit Logs:** Every admin action must log an entry in `AdminAuditLog` within the same mutation handler.
5. **Engineering Standards:** Follow rigorous guidelines regarding observability, disaster recovery, concurrency audits, and data protection as outlined in `07_ENGINEERING_STANDARDS_AND_OPERATIONS.md`.

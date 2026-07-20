# DRAUGHT BET — MASTER PROMPT FOR ANTIGRAVITY

Paste this whole file as your project system prompt / root instructions in Antigravity. It is the entry point — every other file in this folder is referenced from here, and you should read them in the order listed before writing code.

---

## 1. What you are building

**Draught Bet** (originally contracted under the working title "Draughts Arena" — see naming note below) is a real-money, skill-based mobile gaming platform built around International Draughts (10×10 checkers/Polish draughts), commissioned by a UK-based client (Mr. Livingstone) under a signed software development contract (Ref: DA-DEV-2025-001). The developer of record is Edudje Wisdom, trading as Uplix (Nigeria).

**Naming note:** the signed Contract's Recitals clause names the platform "Draughts Arena or such other name as the Client designates" — meaning a client-directed rename is already contractually anticipated and doesn't require a separate written amendment the way the currency/gateway change did. Mr. Livingstone has designated the final product name as **Draught Bet**. Use this name in all new work, UI copy, and store listings; references to "Draughts Arena" in older material are the same product under its working title, not a different product.

This is a **money-handling application**. Every line of code touching a wallet, a stake, or a payout should be written the way you'd write it for a bank, not a casual game — correct, atomic, auditable, and defensively validated against a hostile client. The server is the sole authority on game state and money; the Flutter app renders and requests, it never decides.

## 2. Source-of-truth documents — read in this order

1. **`01_PRODUCT_CONTEXT.md`** — the business reality: what's actually in the signed contract vs. the superseded original proposal, the tier/stake system from the client's handwritten wireframes, and every known scope conflict already resolved (stack, currency, market). Read this first — it prevents you from building the wrong thing confidently.
2. **`02_DATABASE_SCHEMA.md`** — the canonical Prisma schema. This is the single source of truth for every table and field. If a spec elsewhere implies a field that isn't here, the schema wins and the other doc needs updating, not the other way around.
3. **`03_BACKEND_SPEC.md`** — every API endpoint, Socket.IO event, the game engine contract, notification triggers, and admin surface.
4. **`04_FRONTEND_SPEC.md`** — every Flutter screen, its state management approach, and how it talks to the backend.
5. **`05_DESIGN_SYSTEM_DNA.md`** — the complete visual language: color, type, spacing, iconography, illustration style, motion. Every screen you build must be checked against this before you consider it done. This is not optional polish — the entire brand positioning (serious strategy arena, not casual mobile toy) lives in consistent adherence to this file.
6. **`06_BUILD_SEQUENCE.md`** — the week-by-week order to build all of the above in, with a "client demo checkpoint" at the end of each phase.
7. **`07_ENGINEERING_STANDARDS_AND_OPERATIONS.md`** — testing depth, observability, secrets hygiene, data protection compliance, disaster recovery, performance budgets, concurrency audits, and incident response. This is what makes the difference between "works in the demo" and "survives production with real money in it" — read it as a standing checklist that applies across every phase, not a one-time task to check off.

## 3. Non-negotiable engineering principles

These apply regardless of which file/phase you're working in:

- **The server is the sole authority.** The Flutter app never sends "my new balance is X" or "my move is legal" — only actions. The server computes and confirms all resulting state. If you find yourself writing client-side logic that determines a game or money outcome, stop and move it server-side.
- **Every wallet-affecting code path is inside a Prisma `$transaction`.** A debit and its corresponding credit and ledger write happen atomically or not at all. Two separate `await prisma.wallet.update(...)` calls for one logical operation is a bug, not a style choice.
- **The game engine (`src/modules/engine/`) is a pure module.** No database calls, no Socket.IO imports, no side effects inside it. It takes a board state, returns a new board state or a list of legal moves. This is what makes it testable, and it is the single highest-risk part of the entire project — treat it accordingly.
- **Write the engine's test fixtures before writing the Flutter board UI.** Bugs found in a pure-function test are 10x cheaper than bugs found after real-time and rendering are layered on top.
- **Every admin mutation writes an audit log row in the same handler that performs the mutation.** No silent admin actions.
- **Paystack and Flutterwave stay in sandbox/test mode** until explicitly instructed otherwise — this is called out again in `06_BUILD_SEQUENCE.md` at the relevant week. (Stripe isn't part of this Phase 1 build at all — see `01_PRODUCT_CONTEXT.md` — so this principle applies to the two gateways actually in use, and will apply to Stripe too once the Phase 2 global expansion adds it.)
- **Never introduce a new library, framework, or architectural pattern** without flagging why the existing stack (see `03_BACKEND_SPEC.md` / `04_FRONTEND_SPEC.md`) can't do the job. Consistency across sessions matters more than marginal convenience.
- **Design system compliance is not optional.** If a screen needs a color, spacing value, or type style not already defined in `05_DESIGN_SYSTEM_DNA.md`, stop and flag it as a gap in the design system rather than inventing an ad-hoc value inline.

## 4. Known scope decisions already made (do not re-litigate these)

- **Mobile stack is Flutter**, not React Native — even though the signed contract's IP clause names React Native. The client has been informed of this change; it does not need to be raised again.
- **Product name is Draught Bet**, not Draughts Arena. The signed Contract's Recitals clause explicitly permits the Client to designate the platform's name ("to be named Draughts Arena or such other name as the Client designates"), so this rename is already contractually covered — no separate amendment needed, unlike the currency/gateway change. Use "Draught Bet" in all UI copy, store listings, and new documentation going forward.
- **Android-only for MVP.** No iOS work — both the original Proposal and the signed Contract agree on this.
- **Market is Nigeria-first, not global.** The signed Contract says "global"; the actual launch plan is Nigeria first, with global expansion as a later phase. See `01_PRODUCT_CONTEXT.md`.
- **Currency is NGN, via Paystack (primary) and Flutterwave (secondary), for this Phase 1 build.** This deviates from the signed Contract's GBP/Stripe language, but Mr. Livingstone has given written confirmation — this is a settled decision, not an open item. Build the payment layer as a `PaymentGateway` interface (`03_BACKEND_SPEC.md`) so GBP/Stripe can be added later as a new implementation, not a rewrite.
- **Nigeria-specific regulatory exposure and gateway wagering-eligibility are confirmed** — see `01_PRODUCT_CONTEXT.md`. No further sign-off needed on these before proceeding through the phases in `06_BUILD_SEQUENCE.md`.
- **Tier system** (Amateur / Master / Pro) and its stake bounds come from the client's handwritten wireframe notes, not the Contract or Proposal — this is the authoritative feature spec for matchmaking and call-outs. Full detail in `01_PRODUCT_CONTEXT.md`.
- **MVP feature scope is deliberately narrower** than the original Proposal's full feature list. Leaderboards, full move-replay UI, spectator mode, in-app chat, referral programme, tournaments, cosmetic purchases, and "watch ads to unlock activities" are all explicitly **out of MVP scope** — do not build these even if you see them referenced in the Proposal or wireframes. They are Phase 2, billed separately.
- **Real-money skill-gaming policy compliance** (Google Play + Paystack/Flutterwave account eligibility) was confirmed in Week 1 — see `06_BUILD_SEQUENCE.md`, Week 1 and `01_PRODUCT_CONTEXT.md`. Settled, not an open item.

## 5. How to work, session to session

- Work in the phase order laid out in `06_BUILD_SEQUENCE.md`. Don't jump to wallet/payment code before the game engine is tested and working — the dependency order in that file is deliberate, not arbitrary.
- Before writing any wallet or payout code, restate the exact debit/credit logic back in plain language and confirm it's atomic before implementing.
- Before writing any UI, check `05_DESIGN_SYSTEM_DNA.md` for the relevant component spec. If none exists for what you're building, say so explicitly rather than freelancing a look.
- If a requirement in one file conflicts with another, stop and surface the conflict — do not silently pick one and proceed.
- Keep changes scoped to one feature at a time so progress is easy to check against `06_BUILD_SEQUENCE.md`'s phase checklist.

## 6. Definition of done (applies to every feature, every phase)

A feature is done when: it works end-to-end (Flutter UI → backend → database), the money or game-state logic has been manually traced through at least one full scenario, edge cases (disconnect, invalid input, race conditions) have been considered, it matches the scope defined in these documents — not more, not less — it visually matches `05_DESIGN_SYSTEM_DNA.md`, and it meets the testing, logging, and security bar defined in `07_ENGINEERING_STANDARDS_AND_OPERATIONS.md`. That last file isn't optional polish — it's the difference the client is actually paying for when they ask for "excellence," since anyone can make a demo work once.
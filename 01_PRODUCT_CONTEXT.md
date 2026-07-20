# 01 — Product Context

Consolidated business truth from the signed contract, the original (superseded) proposal, and the client's handwritten wireframe notes. Where these three sources conflict, this document states which one wins and why.

## Parties & contract

- **Contract reference:** DA-DEV-2025-001
- **Developer:** Edudje Wisdom, trading as Uplix (Nigeria)
- **Client:** Mr. Livingstone, Platform Owner (United Kingdom)
- **Signed:** June 2026 (the contract document's own header text says "June 2025" — this is a stale template date, not the real signing date; treat June 2026 as correct)
- **Governing law:** England and Wales
- **Contract value:** ₦1,500,000 NGN equivalent, paid in GBP, in three milestones (33% / 33% / 34%) — first milestone already paid

## What's actually being built (Contract wins over Proposal — except where noted below)

| Aspect | Original Proposal (superseded — historical only) | Signed Contract (as written) | Actual build decision |
|---|---|---|---|
| Platforms | Android + iOS | Android only | **Android only** — no conflict |
| Market | Nigeria-first | Global | **Nigeria first, global later** — see note below |
| Currency | Naira (₦) | GBP (£) | **NGN (₦) for Nigeria launch, GBP added in a later global phase** — see note below |
| Payment gateway | Paystack + Flutterwave | Stripe (exclusively, per §3.2) | **Paystack (primary) + Flutterwave (secondary) for Nigeria launch, Stripe added for global phase** — see note below |
| Mobile stack | React Native | React Native | **Flutter** per direct client agreement — resolved, not open |
| Contract value | ₦3,000,000 | ₦1,500,000 (NGN equivalent, paid in GBP) | Unchanged for now — currency of *payment to the developer* is separate from *in-app player currency*, see note below |
| Commission | 10% default | Configurable, no fixed default | Configurable, admin-adjustable from day one |

**Stack note (resolved):** the Contract's IP-transfer clause names "React Native." The actual build uses Flutter. Communicated to the client in writing already — do not revert based on Contract text alone.

**Currency/gateway note (CONFIRMED):** Mr. Livingstone has given written confirmation of the NGN/Paystack/Flutterwave change for the Nigeria launch phase. This is now a settled build decision, the same status as the Flutter/React Native swap — build against it directly, no further sign-off needed before Week 6.

**Why this matters beyond formality:** Contract §5 separately ties the payment *schedule to the developer* to GBP amounts. That flow is untouched by this decision — only the player-facing wallet currency and gateway change. Keep these two money flows distinct when raising the amendment with the client, so it reads as "changing what players use," not "renegotiating how I get paid."

## Nigeria-first rollout plan

- **Phase 1 (MVP, this build):** Nigeria only. NGN wallet, Paystack primary gateway, Flutterwave secondary/redundant gateway — mirrors the dual-gateway pattern already proven on the Tutaly project. Google Play geo-restriction limited to Nigeria at launch.
- **Phase 2 (post-launch, outside this roadmap's dates):** add GBP/Stripe, open geo-restriction to more markets. The payment layer is built as an abstraction from day one specifically so this means *adding* a gateway implementation later, not rewriting the wallet system — see `03_BACKEND_SPEC.md`.

## Regulatory note — Nigeria-specific (CONFIRMED — research complete)

Contract §11 assigns regulatory responsibility to the client, but its language ("UKGC regulations and the laws of any other jurisdiction") was written before Nigeria was the launch market. Real-money skill gaming with Nigerian users can touch state lottery/gaming boards, the National Lottery Regulatory Commission, and potentially CBN wallet-licensing rules if the platform's wallet starts to resemble a payment service rather than pure in-game stakes. This was flagged to and reviewed with Mr. Livingstone alongside the currency/gateway confirmation — treat Nigeria-specific compliance as accounted for going forward, not as an open item blocking any phase.

## Game rules (both Proposal and Contract agree — use as engine spec)

International Draughts, FMJD World Standard, 10×10 board:
- 20 pieces per player on dark squares only
- Mandatory capture — if a jump is available, it must be taken
- Maximum capture rule — must take the path capturing the most pieces
- Backward captures allowed
- Multi-jump chains in a single turn
- King promotion on reaching the back row
- Flying kings — long-range diagonal movement and capture
- Draw conditions: threefold repetition, 25-consecutive-king-moves, minimum 40 moves/player before a draw can be offered
- Forfeit on extended disconnect

## Tier & stake system (from client's handwritten wireframe — authoritative, not in Contract or Proposal)

**Note on the figures below:** the client's original wireframe used GBP amounts. These have been converted to placeholder NGN figures (proportional at roughly ₦600/£1) for the Nigeria-phase build — they are not yet a client-confirmed pricing decision and should be revisited with real Nigeria-market context before launch, same caveat as `02_DATABASE_SCHEMA.md`'s `PlatformSettings` defaults.

| Tier | Description (client's own words) | Normal stake range | Call-out ceiling (separate, higher — see below) |
|---|---|---|---|
| Amateur | "Learner category, not eligible for call-outs" | ₦500 – ₦15,000 | Not eligible |
| Master | "Draught warriors; players know the rules of the game" | ₦10,000 – ₦30,000 | Eligible, up to ₦150,000 |
| Pro | "Draught legends and professionals" | ₦30,000 – ₦60,000 | Eligible, up to ₦300,000 |

**Important distinction — do not conflate these two numbers:** a tier's normal stake range (used for matchmaking and regular play) is deliberately lower than its call-out ceiling. Per the client's own wireframe, a Master player normally stakes ₦10,000–₦30,000 in matched play, but the same player can issue or accept a *call-out* for up to ₦150,000 — a much higher ceiling. This is modeled as two separate fields in `PlatformSettings` (`masterStakeMaxP` vs `masterCalloutMaxP`) specifically so the tier-enforcement middleware never wrongly caps a call-out at the lower matchmaking stake limit.

## Call-out mechanic (client's own definition)

"This is when a player is confident of him/herself and skills and decides to call out or challenge anyone or any user for a match with an amount of his/her own volution [sic]. When a draught player calls out or challenges anyone to a match, all users get notification whether you are eligible or not, but only one person can accept the challenge."

## Onboarding & wallet flow (from wireframe)

1. Download → register with email → select a category → each category shown with brief info, user confirms/continues
2. Account/settings → add email + payment details (bank account) → set up profile → fund wallet → choose category to play
3. Options/settings menu includes: Fund wallet, Withdrawal, Messages, Balance, Legal, Support, Log out

## Home screen zones (from wireframe — authoritative for `04_FRONTEND_SPEC.md` and `05_DESIGN_SYSTEM_DNA.md`)

- Top-left: call-outs and notifications icon
- Top-center: balance display (₦0.00 shown as placeholder)
- Top-right: options/settings icon
- Mid-screen: tier list with stake ranges shown (the wireframe's illustrative "PRO £50 / £75 / £100" example was in GBP — treat these as illustrative stake presets within the tier's NGN range from the table above, not literal fixed values)
- Bottom-left: "Results" — logs previous game results
- Bottom-right: "Activities" — labeled "watch adverts to play activities" in the wireframe

**"Activities" / watch-to-unlock ads feature — explicitly OUT of MVP scope.** This appears only in the client's own wireframe, not in the signed Contract, and was reviewed and deliberately deferred to Phase 2 (see `00_MASTER_PROMPT.md` §4). Do not build an ad SDK integration for MVP.

## Regulatory & compliance position

- Contract §11: the Client (Mr. Livingstone) holds sole and exclusive responsibility for UKGC and any other jurisdiction's regulatory compliance. The Developer provides the technical platform only.
- Practical implication for engineering: geo-restriction, KYC thresholds, and age-gating are still Developer responsibilities to *implement correctly*, even though the *legal* responsibility for licensing sits with the Client. Build these features seriously — "not our legal problem" does not mean "not our engineering problem."
- Google Play's real-money skill-game policy and target launch countries were confirmed in Week 1 — settled, see `06_BUILD_SEQUENCE.md`.
- Paystack and Flutterwave account eligibility for wagering-adjacent payouts was confirmed directly with both providers in Week 1 — settled, not Stripe (see the currency/gateway note above for why Stripe doesn't apply to this Phase 1 build).

## Post-launch support (Contract §10)

30 days of bug-fix support included at no charge, starting from Google Play submission. New feature requests during this period are billed separately — this includes anything from the "explicitly out of MVP scope" list above if the client asks for it during the support window.
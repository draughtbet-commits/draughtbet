# Draught Bet Home Flow Design QA

**Source visual truth**

- `Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/00-core-foundations-screens-001-018.jpeg`
- Source pixels: 1536 × 1024.
- Reviewed region/state: approved Screens 06–18, dark theme.

**Rendered implementation**

- Full comparison: `design-qa-artifacts/screens-06-18-reference-comparison.png`
- Individual captures: `app/test/goldens/home_flow/06_home_lobby.png` through `18_defeat.png`.
- Implementation viewport: 390 × 844 logical pixels at device pixel ratio 1.
- Implementation pixels: 390 × 844 per capture.
- Density normalization: the full approved board remains at its native 1536 × 1024 size in the comparison; each Flutter capture is proportionally reduced only for the contact sheet. Focused checks used the original 390 × 844 captures at 1:1 pixels.
- State: deterministic server-shaped fixtures for Home, Arena, Create, Confirmation, searching, canonical Match Room, live gameplay, selected move, multi-capture/flying-king path, promotion, opponent thinking, authoritative victory, and authoritative defeat.

**Full-view comparison evidence**

- The final composite was opened and inspected after the last visual fixes.
- Composition, hierarchy, five-tab navigation, dark navy surfaces, emerald actions, gold value treatment, card geometry, 10×10 board proportions, and terminal-result color treatments follow the approved sequence and visual direction.
- Financial and game truth intentionally remain server-authoritative. Where the current backend exposes no clock/ready contract, the UI shows `READY` or `--:--` instead of fabricating the approved example countdown.

**Focused region comparison evidence**

- `06_home_lobby.png`: greeting, balance hierarchy, quick-stake controls, active-match card, and five-tab navigation checked at 1:1.
- `07_open_arena.png`: four dense player cards, rank/value accents, Join controls, and navigation checked at 1:1.
- `12_live_gameplay.png`, `13_move_selection.png`, `14_flying_king_capture.png`, and `16_opponent_thinking.png`: board scale, piece contrast, selected ring, non-color-only legal marker, capture path, interaction freeze, player strips, and action rail checked at 1:1.
- `15_king_promotion.png`: transparent crowned-piece asset, dimmed canonical board, gold heading, scale, and masking checked at 1:1.
- `17_victory.png` and `18_defeat.png`: result color, identity, money breakdown, settlement status, and Home action checked at 1:1.

**Findings**

- [P3] Repository avatar illustrations are flatter than the photographic portraits in the presentation board.
  Location: Home, Arena, Match Room, Gameplay, and Results.
  Evidence: the approved board uses portrait-style faces; the existing application contract maps backend avatar IDs to its bundled SVG avatar catalog.
  Impact: the subject treatment is visibly simpler, but identity, crop, ring, sizing, and hierarchy remain consistent.
  Classification: acceptable repository-source constraint for this change. Existing user avatar assets were preserved instead of being overwritten.

- [P3] Decorative floor perspective and result confetti are more restrained than the presentation board.
  Location: Matchmaking, Match Room, Victory, and Defeat.
  Evidence: the implementation retains the approved palette and glow but prioritizes readable live state over non-contract decoration.
  Impact: minor atmosphere difference; no hierarchy or task-flow impact.
  Classification: optional polish if client-owned production exports become available.

**Comparison history**

1. Initial rendered pass found missing Lucide glyphs and a missing promotion overlay in screenshot evidence, plus responsive overflows in the raised Play navigation item, Match Room status, and long Create Match board value.
2. Fixes applied: loaded the package-qualified Lucide font in golden rendering; increased navigation height; made long room text flexible; made dropdowns expanded; moved promotion into the gameplay state layer; and added a project-local transparent crowned-piece asset.
3. The initial balance capture also used the wrong financial font/fraction presentation. It now uses Inter and integer-only money formatting with an explicit two-digit kobo display for available balance.
4. Post-fix evidence: all thirteen 390 × 844 goldens render without Flutter exceptions or overflow, and the final composite at `design-qa-artifacts/screens-06-18-reference-comparison.png` shows no remaining actionable P0, P1, or P2 mismatch.

**Open questions**

- A future backend contract must supply authoritative ready state, server clock synchronization, draw/chat events, and settlement updates before those controls can claim completion. The current UI labels unavailable actions and never fabricates financial or gameplay truth.

**Implementation checklist**

- [x] Sora and Inter bundled locally.
- [x] Approved semantic palette and reusable surface/button/player components applied.
- [x] Screens and states 06–18 captured at 390 × 844.
- [x] Five required navigation paths covered.
- [x] Small phone, standard phone, scaled text, and tablet-width layout checks added.
- [x] Final full-view and focused visual comparisons completed.

**Follow-up polish**

- Replace the preserved avatar catalog and restrained decorative effects only if client-owned, production-ready exports are supplied.

## PR3 wallet reads and PR4 match lifecycle extension

**Approved sources reviewed**

- `04-wallet-deposits-transactions-043-054.png` and `10-empty-loading-error-states-108-119.png` for wallet read screens and supporting states.
- `02-match-entry-stake-ready-031-042.png`, `03-match-entry-stake-ready-alternate.png`, and the existing approved Screens 6–18 flow for match-entry continuity.
- Supporting documents were used for behavior and state requirements; the approved boards remained the visual authority.

**Rendered evidence**

- Wallet comparison: `design-qa-artifacts/pr3-wallet-reference-comparison.png`.
- Match lifecycle comparison: `design-qa-artifacts/pr4-match-lifecycle-reference-comparison.png`.
- Wallet captures: `app/test/goldens/wallet_read/` (9 states at 412 × 915, DPR 1).
- Match lifecycle captures: `app/test/goldens/match_lifecycle/` (16 states at 412 × 915, DPR 1).

**Findings and resolution**

1. The initial PR3/PR4 pass matched the approved palette, card system, typography hierarchy, action treatment, and server-authoritative state language.
2. The initial PR4 capture lacked the approved illustration weight in insufficient-balance, stake-limit, and pre-start disconnect states because no matching production exports were present. Isolated transparent replacements were generated in the established emerald/gold/dark style, bundled locally, accessibility-labelled, and re-captured.
3. The final PR4 comparison confirms the replacement illustrations now carry the intended hierarchy without introducing raw UI colours or changing the backend contract.
4. No Flutter exceptions, render overflow, P0, P1, or actionable P2 mismatch remains in the captured PR3/PR4 states.

**Remaining source constraints**

- Player discovery continues to use the repository avatar-ID catalog. Client-owned portrait exports can replace those assets later without changing screen structure.
- Live balances, lock/release progress, eligibility, ready state, room codes, challenges, and opponent presence still require authoritative backend payloads. Production screens do not manufacture those values.

final result: passed

## PR7 withdrawal UI extension

**Approved sources reviewed**

- `04-wallet-deposits-transactions-043-054.png` for Withdraw Money and Select Bank Account.
- `07-gameplay-results-settlement-079-090.png` for the visible Pending Review, Provider Processing, Confirmed, and Reversed withdrawal variants.
- `13-money-lifecycle-extra-states.png`, `14-withdrawal-status-variants.png`, and `10-empty-loading-error-states-108-119.png` for review, bank-verification failure, and supporting state patterns.
- `FLOW-06-withdrawal` and the state/contract manifests for behavior only. The incorrectly named withdrawal/KYC board was not treated as visual truth because its checked-in contents show unrelated screens.

**Rendered evidence**

- Twelve deterministic 412 x 915 captures are stored in `app/test/goldens/withdrawal_flow/`.
- Captures cover Withdraw Money, Select Bank Account, Add Bank Account, Verifying Bank Account, Withdrawal Review, Verification Required, Pending Review, Processing, Successful, Reversed, Limit Reached, and Saved Bank Accounts.
- Each capture was opened at rendered resolution after golden generation. The focused visual suite was then rerun without `--update-goldens` to prove stable output.

**Findings and resolution**

1. The implementation follows the approved black background, navy card surfaces, emerald primary actions, gold pending treatment, red reversal treatment, outlined secondary actions, rounded geometry, and Sora/Inter hierarchy.
2. The initial amount capture exposed a missing Naira glyph in the input prefix. The prefix now explicitly uses bundled Inter and was re-captured.
3. Status cards were expanded to show only server-returned amount, provider fee, net/requested amount, destination, masked reference, status, and available balance. No fee, payout, limit, or balance is calculated in Flutter.
4. Exact dedicated frames for several middle withdrawal states are absent from the usable approved board checked into this repository. Those states use the approved component language and the manifest-defined hierarchy without inventing a second visual direction.
5. No Flutter exception or render overflow remains in the focused standard-phone and small-phone/text-scaling checks.

**Contract boundary**

- Production uses `POST /withdrawals/quote`, `GET /bank-accounts`, `POST /bank-accounts/verify`, `POST /withdrawals`, and safe status reads from the existing withdrawal reference.
- The current backend does not yet expose those V2 routes. The UI therefore shows approved unavailable or pending states and never falls back to local financial truth.
- A create response never implies success; only a server-returned terminal status can show Confirmed or Reversed. Polling is bounded, cancelable, and cannot submit another withdrawal.

final result: passed

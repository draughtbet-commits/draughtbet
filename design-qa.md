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

## PR9 server clock and reconnect UI extension

**Source visual truth**

- `Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/06-profile-support-gameplay-067-078.png`, using its visible screens 82, 83, and 86 for opponent disconnect, timeout, and disconnect-forfeit treatments.
- `Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/03-match-entry-stake-ready-alternate.png` for the pre-match opponent-grace visual language.
- Source board pixels: 1536 x 1024. The board was inspected at native resolution; filenames were not used to override visible content.

**Rendered implementation**

- Combined approved-to-rendered evidence: `app/test/goldens/pr9_qa/comparison.png`.
- Individual captures: `app/test/goldens/home_flow/43_opponent_disconnected_before_start.png`, `82_opponent_disconnect_countdown.png`, and `pr9_*.png`; disconnect-forfeit capture: `app/test/goldens/settlement_result/72_disconnect_forfeit.png`.
- Flutter viewport and implementation pixels: 390 x 844 at DPR 1 for every state.
- Density normalization: individual Flutter captures were inspected at 1:1. The approved 1536 x 1024 board and the 390 x 844 renders were placed in the same Chrome-rendered comparison sheet without altering their source files.
- States: pre-match grace, connection lost, reconnecting, app resumed, low time, timeout imminent, opponent disconnect grace, and authoritative disconnect forfeit.

**Full-view and focused comparison evidence**

- The combined sheet was opened and inspected after capture generation. The gameplay board remains visible beneath a darkened layer; disconnect and recovery states use the approved centered navy card, emerald outline/progress, restrained icons, uppercase Sora headings, and Inter support copy.
- Focused 1:1 checks were performed on the live disconnect overlay, connection-lost action card, low-time pill, and disconnect-forfeit result. These regions contain the significant typography, state color, control, and icon detail; no additional crop was needed.
- The pre-match grace state uses the existing approved Match Room structure and adds a monotonic circular grace indicator without inventing a terminal result or fund release.

**Findings and comparison history**

1. Initial contract inspection found a P0 runtime mismatch: Flutter connected to a nonexistent `/game` namespace and expected nested per-player clock values. It now connects to the backend root namespace and consumes the flat `clock.sync`, `match.state`, and `move.accepted` clock fields.
2. Initial recovery behavior used device wall-clock timestamps and could resume from network connectivity alone. It now uses monotonic display-only elapsed time, blocks moves through connection loss/reconnect/app resume, and resumes only after canonical server state arrives.
3. The first focused test pass found stale tests expecting unsupported draw events and a recovery overlay precedence mismatch. Tests and event handling were aligned to the actual Backend V2 contract; unsupported draw commands are no longer emitted.
4. Post-fix captures have no Flutter exception, clipped persistent control, or render overflow. Typography, spacing, semantic colors, Lucide icons, copy hierarchy, and existing board imagery match the approved component language. No actionable P0, P1, or P2 visual difference remains in the PR9-owned state layer.

**Contract boundary and accessibility**

- The server remains authoritative for clocks, timeout, reconnect grace, forfeit, and result. A local display reaching zero changes only to `AWAITING SERVER RESULT`.
- Backend V2 supplies a grace duration but no absolute grace-expiry timestamp. The circular countdown is therefore an approximate monotonic display and waits for the server outcome after zero.
- Recovery and urgent-clock states expose live-region semantics, moves remain disabled while unsynced, retry is a labelled button, and small-screen/text-scaling coverage checks the overlay for overflow.

**Follow-up polish**

- The supporting low-time and app-resumed frames are derived from the approved gameplay card/pill system because the source board provides terminal timeout and disconnect frames rather than dedicated intermediate frames.

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

## PR8 game protocol UI extension

**Approved sources reviewed**

- `00-core-foundations-screens-001-018.jpeg` for Match Room, Live Match, Move Selection, multi-capture/flying-king, King Promotion, and Opponent Thinking.
- The board visibly containing screens 79-90 for Offer Draw, Draw Rejected, and Resign confirmation treatments.
- `12-postgame-disputes-safer-play-extra.png` for the paired-turn Move History table.
- Gameplay contracts were used for behavior only: Flutter sends intentions and renders canonical server state; it never determines legal moves, applies a board mutation, or decides a result locally.

**Rendered evidence**

- Existing captures `11_match_room.png` through `16_opponent_thinking.png` continue to cover the approved core gameplay states.
- Nine new deterministic 390 x 844 captures are stored in `app/test/goldens/home_flow/pr8_*.png`.
- New captures cover Mandatory Capture, Illegal Move, State Resync, Draw Offer Received, Draw Offer Rejected, Offer Draw confirmation, Resign confirmation, Match Menu, and Move History.
- The visual suite passed after golden generation and again without `--update-goldens`.

**Findings and resolution**

1. Draw and resign dialog screenshots initially excluded Flutter's overlay layer. Capture targeting was corrected so the full modal and bottom-sheet treatment is verified.
2. Move History initially rendered one accepted move per row. It now follows the approved paired-turn layout while remaining sourced exclusively from the durable server move log.
3. Illegal/stale move feedback now uses the approved centered gameplay card instead of a floating action button. Stable server rejection codes provide safe copy; a state-version conflict blocks input and requests canonical state without retrying the move.
4. Mandatory capture and full multi-capture paths are visually distinct, accessible, and server-provided. Promotion remains driven only by an accepted server event.
5. V1 and V2 Socket.IO names coexist during migration. Read-only room joins may use both names; every state-changing move, draw, or resign command selects exactly one protocol path, preventing duplicate mutations.
6. Standard-phone and 320 x 568 small-screen checks show no Flutter exception or render overflow.

**Contract boundary**

- The checked-in backend currently exposes the legacy gameplay event names and a V1 canonical state read. V2 dotted events, draw actions, stable rejection codes, and durable accepted move history must be supplied by the PR8 backend before every production state can be live.
- The current `GET /matches/:id/state` response does not expose the durable accepted-move log required by Move History. The screen therefore shows an approved unavailable/empty state rather than reconstructing moves in Flutter.
- PR9 owns authoritative clocks, low-time warnings, reconnect timing, app-resume recovery, and disconnect-forfeit rules. PR8 does not infer or implement those outcomes.

final result: passed

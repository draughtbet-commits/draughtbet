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

final result: passed

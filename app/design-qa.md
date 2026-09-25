# Waiting Match Home Navigation — Design QA

- Source visual truth:
  - `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/02-match-entry-stake-ready-031-042.png` (visible Screen 39)
  - `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/00-core-foundations-screens-001-018.jpeg` (visible Screen 6)
- Implementation screenshots:
  - `test/goldens/home_flow/39_waiting_opponent_back_home.png`
  - `test/goldens/home_flow/06_home_pending_match.png`
- Combined comparison: `test/goldens/waiting_match_qa/comparison.png`
- Viewport: 390 × 844 logical pixels, device pixel ratio 1
- Source pixels: both approved boards are 1536 × 1024 composite boards; the relevant phone panels were cropped and aspect-fitted into 390 × 814 comparison cells without stretching.
- Implementation pixels: 390 × 844 for each Flutter golden.
- States: waiting for opponent with Back to Home; Home with a pending active-match card.

## Findings

No actionable P0, P1, or P2 differences remain for the requested change.

- Fonts and typography: Sora headings and Inter body/value text preserve the established hierarchy. The added support copy remains legible and wraps without clipping at supported compact widths.
- Spacing and layout rhythm: the secondary Home action is separated from the authoritative stake state and keeps a 50-pixel touch target. The Home card occupies the approved match-in-progress region without replacing normal lobby content.
- Colors and visual tokens: all new UI uses the existing black, navy, emerald, gold, white, muted-text, and border tokens. No raw colors were introduced.
- Image and icon fidelity: existing production avatars and Lucide icons were retained. The approved composite uses a decorative chip illustration, while the existing production waiting screen uses player status; that pre-existing product structure was intentionally preserved because this task adds navigation and status continuity rather than redesigning the screen.
- Copy and content: the added copy accurately says the match remains open. The Home card shows only server-known stake/type/time, a masked reference, and last-known status.
- Accessibility and responsiveness: buttons expose labels and enabled state, meet minimum touch size, and the waiting/Home layouts have no overflow at 320 × 568 with 1.2× text scaling.

## Comparison History

1. Initial comparison found a P2 density mismatch in the waiting details card and compact-width overflow in the shared terms rows.
2. The waiting screen was changed to the approved two-party stake-status pattern, the reference title was shortened safely, and the screen body was made scrollable when required.
3. A separate P2 text-scaling overflow in the Home “Find a Match” CTA was fixed by allowing the control to grow above its approved minimum height.
4. Revised captures show the added action, pending Home card, typography, spacing, tokens, and responsive behavior without P0/P1/P2 issues.

Focused regions were not required after the final full-view comparison because all newly added controls, status copy, value chips, and references are readable at the captured 390 × 844 size.

final result: passed

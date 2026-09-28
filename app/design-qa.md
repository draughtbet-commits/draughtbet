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

---

# PR10 Design QA

## Evidence

- Approved KYC screens 55-66: `/home/uplix/Downloads/ChatGPT Image Sep 8, 2026, 02_17_21 AM (4).png`
- Approved KYC result screens 67-70: `/home/uplix/Downloads/ChatGPT Image Sep 8, 2026, 02_17_21 AM (5).png`
- Approved safer-play screens 91-102: `/home/uplix/Downloads/ChatGPT Image Sep 8, 2026, 02_19_03 AM (2).png`
- Approved account-restricted state: `Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/05-withdrawals-kyc-055-066.png`
- Flutter captures: `app/test/goldens/pr10/*.png`

The implementation captures use a 412 x 915 logical-pixel Android viewport.
The approved sources are multi-screen boards with device chrome, so comparison
used the corresponding visible phone frame rather than treating the entire board
as a same-size screenshot.

## Comparison result

The captured screens preserve the approved hierarchy and established black,
emerald, gold, white and muted-blue visual language. Titles, status treatments,
outlined information cards, primary actions, spacing, safe-area behavior and
small-screen scrolling match the approved component direction. All ten PR10
goldens render without overflow.

The source boards contain bespoke 3D illustration renders which are not supplied
as individual production assets. The implementation therefore uses the existing
Lucide-based Draught Bet icon treatment in those hero positions. This is the only
material visual variance; no financial, identity or eligibility data was invented
to make the captures resemble the boards.

Final result: **passed with documented source-asset limitation**.

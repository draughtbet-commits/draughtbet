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

# PR12 Notifications and Reconciliation Design QA

- Source visual truth:
  - `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/12-postgame-disputes-safer-play-extra.png`, visible Notifications frame.
  - `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/11-tier-callout-extra-flow.png`, visible Notifications alternate.
  - `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/10-empty-loading-error-states-108-119.png`, visible Empty Notifications frame.
- Implementation screenshots: `test/goldens/pr12/*.png`.
- Combined comparison: `test/goldens/pr12_qa/comparison.png`.
- Viewport: 412 x 915 logical pixels at device pixel ratio 1.
- Source pixels: the primary and alternate notification cells are 256 x 512 crops from their composite boards; the empty-state cell is a 384 x 342 crop. The comparison aspect-fits each source and implementation without stretching.
- Implementation pixels: 412 x 915 for each Flutter golden.
- States: Notifications, No Notifications, Notification Details, and Notification Preferences.

## Findings

No actionable P0, P1, or P2 differences remain for the visible approved notification list and empty state.

- Fonts and typography: Sora headings and Inter list/detail text preserve the approved hierarchy, weight, wrapping, and dense notification-card treatment.
- Spacing and layout rhythm: the four approved filters, compact cards, unread indicators, persistent navigation, centered empty state, and full-width actions match the approved composition. The initial AppBar capture truncated the title; the preferences shortcut was moved back to Profile settings and the final capture shows the complete title.
- Colors and visual tokens: all PR12 UI uses the shared black, navy, emerald, gold, white, muted-blue, warning, and danger semantic tokens. No raw colors were added.
- Image and icon fidelity: Lucide icons are used consistently with the existing application and approved notification patterns. No placeholder, emoji, custom SVG, or fabricated image asset was introduced.
- Copy and content: list/detail values come only from backend notification records. The empty copy follows the approved board. Preferences identify critical money and security updates as non-disableable.
- Interaction and responsiveness: filtering, pagination, safe refresh, bounded backoff, read acknowledgements, mark-all-read, detail navigation, invalid-link rejection, replay deduplication, empty/error handling, and compact layouts are covered by focused tests.

Notification Details and Notification Preferences do not have usable dedicated phone frames in the checked-in boards: the manifest points preferences to VIS-08, while that checked-in image visibly contains match-entry screens. Those two states therefore reuse the approved notification cards, settings switches, semantic tokens, typography, and action patterns without introducing a new visual direction.

## Comparison History

1. The first rendered pass found a P2 AppBar title truncation caused by two trailing actions and a P2 solid green block caused by the shared scroll page painting only its content height.
2. The preferences action was kept in Profile settings, notification pages were given a full-height black surface, the empty-state filters were removed to match its dedicated frame, and six server-shaped items were captured to match the approved list density.
3. The post-fix captures and combined comparison show complete headings, stable full-height backgrounds, readable cards, aligned filters, approved empty-state hierarchy, and no remaining P0/P1/P2 issue.

Focused regions were not required after the final full-view comparison because the list cards, unread dots, filters, empty illustration treatment, detail copy, switches, and actions are clearly readable in the original 412 x 915 captures.

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

---

# PR11 Player Disputes Design QA

- Source visual truth: `../Draught_Bet_Approved_UI_UX_Handoff_v1/approved-visuals/12-postgame-disputes-safer-play-extra.png`, visible screens 6-9.
- Implementation captures: `test/goldens/pr11/*.png`.
- Combined comparison: `test/goldens/pr11_qa/comparison.png`.
- Flutter viewport: 412 x 915 logical pixels at device pixel ratio 1.
- Source pixels: 1024 x 1536 composite board. Each relevant phone viewport was cropped from its 256 x 512 board cell, aspect-fitted and padded without stretching before comparison.
- Implementation pixels: 412 x 915 per capture.
- States: Report Match, Dispute Reason, Add Evidence, Dispute Submitted and Dispute Status.

## Findings

No actionable P0, P1 or P2 visual differences remain.

- Fonts and typography: Sora headings and Inter body text preserve the approved hierarchy, weight and wrapping.
- Spacing and layout rhythm: match summary, choice cards, evidence form, confirmation details and status timeline follow the approved vertical rhythm and remain scrollable on compact screens.
- Colors and visual tokens: all PR11 UI uses the shared black, navy, emerald, gold, white and muted-blue semantic tokens. No raw colors were added.
- Image and icon fidelity: existing production avatars and Lucide icons were reused consistently. Device chrome and decorative board-only effects were not recreated as application content.
- Copy and content: report, review and decision copy never promises a result or balance change. Identifiers are masked where appropriate. Add Evidence is derived from the approved Dispute Reason component pattern because no dedicated approved frame exists.
- Interaction and responsiveness: selection, validation, navigation, duplicate-submit prevention, unavailable states and safe status refresh are covered. The five screens render without overflow at 320 x 568 with 1.25x text scaling.

The backend currently exposes dispute management only through admin RBAC routes. The production player flow therefore shows an approved unavailable state and never displays Dispute Submitted without a server-confirmed case. Test fixtures are used only for widget and visual capture evidence.

Focused regions were not required after the full-view comparison because all report choices, case fields, timeline labels and actions remain legible in the normalized comparison artifact.

final result: passed

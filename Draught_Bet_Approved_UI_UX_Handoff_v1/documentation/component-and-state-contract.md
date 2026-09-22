# Draught Bet component and state contract

## Visual source

All implementation must extend the client-approved navy/emerald/gold boards in `approved-visuals/`. The later generated 160-screen visual redesign is excluded. The 160-state manifest is retained only as a behavioural and engineering inventory.

## Reusable components

- Top app bar; five-item bottom navigation; primary, secondary, destructive and text buttons.
- Text, password, OTP, amount and search fields with focus, error, disabled and loading states.
- Balance, match, player, transaction, notification, quote, receipt and status cards.
- Avatar, tier badge, status pill, timer chip, wallet row and server-quote block.
- 10x10 board cells, pieces, kings, legal-move highlight, mandatory-capture highlight and connectivity banner.
- Dialog, bottom sheet, confirmation panel, loading state, skeleton, empty state and recoverable failure state.

## Required variants

Default, pressed, focused, disabled, loading, empty, success, warning, danger, pending, stale, offline, restricted, quote-expired, duplicate-request, unknown-outcome and reversed.

## State ownership

The server owns eligibility, fee quote, tier limits, balances, stake locks, legal moves, clocks, result, settlement, KYC, withdrawal and dispute status. The Flutter client owns presentation, local drafts and temporary selection affordances only.

## Accessibility

Use 48dp touch targets where possible and never below 44dp. Support Android text scaling, TalkBack labels, logical focus order and non-colour status cues. Amounts use tabular figures. Do not place essential text inside raster illustrations.

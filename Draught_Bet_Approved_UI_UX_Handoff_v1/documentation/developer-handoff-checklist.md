# Developer handoff checklist

## Before implementation

- [ ] Product owner reviews the canonical state manifest and approved-board register.
- [ ] Original brand and illustration assets are delivered.
- [ ] Payment provider, KYC provider and supported bank-account flow are confirmed.
- [ ] Legal and safer-play copy is reviewed for the launch jurisdiction.
- [ ] Backend API and Socket.IO contracts are versioned and frozen for the first vertical slice.

## Per screen/state

- [ ] Uses the approved visual reference and shared tokens.
- [ ] Handles loading, empty, error, timeout and offline conditions where applicable.
- [ ] Displays server-provided money values without recalculation.
- [ ] Prevents duplicate mutation submission.
- [ ] Supports Android system insets, text scaling and TalkBack.
- [ ] Has widget/golden tests and contract tests for critical states.

## Money and gameplay release gate

- [ ] Idempotency is verified for deposits, withdrawals, stake locks, refunds and settlement.
- [ ] Concurrent balance/stake/withdrawal tests pass.
- [ ] Reconnect and stale-state tests pass.
- [ ] The app never shows an unverified financial success state.
- [ ] Receipts include immutable references and authoritative timestamps.

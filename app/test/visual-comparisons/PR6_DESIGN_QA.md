# PR6 Deposit UI design QA

Status: Passed with one documented asset limitation.

Compared against:

- `04-wallet-deposits-transactions-043-054.png` screens 45-49
- `13-money-lifecycle-extra-states.png` states M6-M8
- `FLOW-05-deposit`

Verified:

- Dark navy, emerald, gold, white and muted-blue approved token palette.
- Approved title, card, detail-row, payment-method and primary/secondary action hierarchy.
- Add Money, Payment Method, Hosted Checkout, Processing, Successful, Failed and Pending states.
- Server-authoritative values, masked instruments/references and pending-first checkout return.
- 412x915 golden captures and 320x568 layout at 1.5x text scaling without overflow.

Documented difference:

- The handoff does not contain standalone deposit coin/check/failure illustration assets. The implementation uses the existing Lucide icon system with approved glow, color and spacing instead of extracting artwork from the composite boards.

Evidence:

- Individual captures: `test/goldens/deposit_flow/`
- Side-by-side board: `test/visual-comparisons/pr6-deposit-reference-comparison.png`

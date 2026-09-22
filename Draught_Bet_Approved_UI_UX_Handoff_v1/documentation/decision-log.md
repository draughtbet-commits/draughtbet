# Source-of-truth decisions

1. The client-approved visual boards are the visual source of truth.
2. The 160-state inventory is behavioural only; its regenerated screen artwork is excluded.
3. The five-tab navigation is Home, Arena, Play, Wallet and Profile.
4. Flutter targets Android. Concept-board phone chrome is presentation only.
5. Fees, stakes, tier limits, balances, quotes and settlement statuses come from the server.
6. The interface must not report deposit success before verified provider confirmation.
7. A match result can be final while settlement remains processing or delayed.
8. Moves remain disabled during reconnect until authoritative state and version are synchronized.
9. Full replay is future phase; Phase 1 may expose server-recorded move notation and receipts.
10. Original logo, illustration and icon source assets are still required; screenshot crops are not production assets.
11. Legacy board copy mentioning blockchain is obsolete. Use server-authoritative wallet-ledger language such as “Locking your stake securely.”
12. Sample countries, device chrome, providers, amounts and percentages shown in concept boards are illustrative unless explicitly approved in this log.

## Legacy numbering resolution

The approved visual boards contain 176 visible phone frames, a main legacy sequence through 119, duplicate numbers 97-102, alternate compositions and extra boards. The implementation manifest therefore uses stable IDs such as `DB-GAME-001` rather than relying on legacy numbers.

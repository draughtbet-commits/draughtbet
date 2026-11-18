# Draught Bet — Admin Web (`admin-web/`)

Next.js App Router + TypeScript + Tailwind CSS administrative control plane for Draught Bet.

## Development & Verification Commands

```bash
# Start development server
pnpm dev

# Run TypeScript check
npx tsc --noEmit

# Run Configuration UI & API integration test suite
pnpm test

# Run production build
pnpm build
```

## Phase 4 Configuration Management Routes

- `/configuration` — **Module A:** Configuration Overview Dashboard
- `/configuration/platform` — **Module B:** Platform Settings & Identity (`PLATFORM`, `meta`)
- `/configuration/game` — **Module C:** Game Configuration & Ruleset Parameters (`GAME`)
- `/configuration/financial` — **Module D:** Financial Configuration, Rake & Tier Stake Bands (`FINANCIAL`, `TIERS`)
- `/configuration/kyc` — **Module E:** KYC & Regional Eligibility Policy (`KYC`)
- `/configuration/safer-play` — **Module F:** Safer-Play Policy & Player Protection Controls (`SAFER_PLAY`)
- `/configuration/matchmaking` — **Module G:** Matchmaking Queue & Pairing Worker Configuration (`MATCHMAKING`)
- `/configuration/feature-flags` — **Module H:** Feature Flags, Deterministic Rollouts & Kill Switches
- `/configuration/notifications` — **Module I:** Notification Template Management & Server Preview
- `/configuration/maintenance` — **Module J:** Maintenance Controls, Scope Matrix & Emergency Recovery
- `/configuration/versions` — **Section 5:** Configuration Version History, Diff Comparison & Rollback
- `/configuration/approvals` — **Section 6:** Maker-Checker Approval Queue & Atomic Activation

See [`docs/frontend-handoffs/2026-11-17-phase4-configuration-management-ui.md`](../docs/frontend-handoffs/2026-11-17-phase4-configuration-management-ui.md) for the complete architecture, API integration reference, and RBAC permission matrix.

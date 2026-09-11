# Draught Bet approved UI/UX handoff

This package preserves the client-approved visual direction and organizes the existing boards into an implementation planning and review reference.

## Verified inventory

- 15 approved visual boards
- 176 visible phone frames across source boards, including alternates and extensions
- 160 canonical implementation states
- 10 end-to-end UX flow maps

## Open first

Open `gallery/index.html` for the browsable gallery. Use `documentation/Draught_Bet_Approved_UI_UX_Handoff_v1.pdf` for review meetings and `manifests/screen-state-manifest.csv` during implementation.

## Source hierarchy

1. Approved visual boards: appearance and composition.
2. Screen-state manifest: behaviour, events, endpoints and operational states.
3. Flow maps: navigation, failure branches and server-authority rules.
4. Design tokens and component contract: implementation consistency.

## Important limitation

API names, socket events, routes and behavioral mappings are proposed handoff contracts carried forward from the design specification. They have not been verified against the current repository in this packaging pass. Validate them before integration. The 160 states include 37 component-derived states without a direct source-board match; this count is not a claim of 160 separately approved designs. Flow maps summarize major branches and do not replace per-endpoint response schemas or a clickable app prototype.

The original logo, icons and illustrations are embedded inside the approved boards. They are not safe production exports. Obtain the source assets listed in `assets/asset-register.csv`; do not crop them from screenshots.

## Implementation-state sections

- Auth & onboarding: 17
- Home & matchmaking: 29
- Live gameplay: 20
- Results & settlement: 12
- Wallet & deposits: 15
- Withdrawals: 11
- KYC & compliance: 10
- History, account & disputes: 20
- Safer play, support & system: 26

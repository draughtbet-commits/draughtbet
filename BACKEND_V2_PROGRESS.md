# Draught Bet Backend V2 Progress

Current branch: refactor/backend-v2

## Current Phase
PR 0 — Baseline & Safety Net

## Current Objective
Protect existing working behaviour before starting financial architecture changes.

## PR Roadmap

- [ ] PR 0 — Baseline & Safety Net
- [ ] PR 1 — Add V2 Database Schema
- [ ] PR 2 — LedgerService
- [ ] PR 3 — Switch Wallet Reads to Ledger
- [ ] PR 4 — Match Lifecycle + Stake Reservation
- [ ] PR 5 — Settlement V2
- [ ] PR 6 — Deposit V2
- [ ] PR 7 — Withdrawal V2
- [ ] PR 8 — Game Protocol V2
- [ ] PR 9 — Server Clock + Reconnect
- [ ] PR 10 — KYC + Eligibility + Safer Play
- [ ] PR 11 — Admin + RBAC + Audit + Disputes
- [ ] PR 12 — Workers + Reconciliation + Outbox
- [ ] PR 13 — Security + Production Hardening

## PR 0 Checklist

- [ ] Existing backend installs successfully
- [ ] Existing Prisma client generates
- [ ] Existing test suite executed
- [ ] Passing/failing baseline recorded
- [ ] Auth smoke tests confirmed
- [ ] Matchmaking smoke tests confirmed
- [ ] Callout acceptance test confirmed
- [ ] Full game completion test confirmed
- [ ] Settlement test confirmed
- [ ] Deposit webhook test confirmed
- [ ] Withdrawal/refund test confirmed
- [ ] Request ID middleware added
- [ ] Feature flag infrastructure added
- [ ] Unused Stripe dependency investigated
- [ ] CI still passes
- [ ] PR 0 review completed

## Current Blockers
None

## Do NOT work on yet
- Ledger V2
- New Prisma finance models
- KYC refactor
- Settlement rewrite
- Socket protocol rewrite
- Flutter UI rewrite
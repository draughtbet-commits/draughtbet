# Draught Bet — Phase 4 Milestone 4: Complete Configuration Management UI Handoff

**Date:** November 17, 2026  
**Branch:** `ui/password-recovery-ui`  
**Scope:** Admin Web (`admin-web/`) & Backend Configuration API Integration (`backend/src/modules/`)

---

## 1. Architecture Overview

The Draught Bet Configuration Management UI is built inside the existing **Next.js App Router (`admin-web/`)** application using strict TypeScript and the established dark administrative design system (`#0B0D10` Void, `#15181D` Surface 1, `#1E2229` Surface 2, `#272C34` Surface 3, `#2E333B` Hairline, `#E7B24A` Gold).

Core architectural boundaries:
- **PostgreSQL & Backend Authority:** All configuration state, RFC 8785 canonical JSON SHA-256 checksums, Maker-Checker approvals, atomic activations, feature flag evaluations, template renderings, and maintenance scope rules are owned and enforced by the Express 5 / Prisma 7 backend.
- **Reusable Domain Editing Workspace (`DomainConfigWorkspace.tsx`):** Provides a unified workflow across all six domain pages (`PLATFORM`, `GAME`, `FINANCIAL` + `TIERS`, `KYC`, `SAFER_PLAY`, `MATCHMAKING`):
  1. Loads active configuration (`GET /api/v1/admin/config/active`) and version history (`GET /api/v1/admin/config/versions`).
  2. Supports creating a new draft or resuming an existing un-submitted `DRAFT` version.
  3. Tracks unsaved edits with `beforeunload` browser protection.
  4. Runs server-side dry-run validation (`POST /api/v1/admin/config/drafts/validate`).
  5. Opens a pre-submission review modal displaying structured domain diffs (`ConfigDiffViewer.tsx`) and requiring an auditable `changeReason` (minimum 5 characters).
  6. Saves drafts (`POST /api/v1/admin/config/drafts` / `PATCH /api/v1/admin/config/drafts/:id`) or submits directly into the immutable Maker-Checker approval queue (`POST /api/v1/admin/config/drafts/:id/submit`).

---

## 2. Configuration Module Route Map

| Module | Route | Component File | Backend Domain / Model |
|---|---|---|---|
| **Module A: Configuration Overview** | `/configuration` | `admin-web/src/app/(admin)/configuration/page.tsx` | `PlatformConfigVersion`, `FeatureFlag`, `NotificationTemplate`, `MaintenanceState`, `AdminAuditLog` |
| **Module B: Platform Settings** | `/configuration/platform` | `admin-web/src/app/(admin)/configuration/platform/page.tsx` | `PLATFORM` & `meta` |
| **Module C: Game Configuration** | `/configuration/game` | `admin-web/src/app/(admin)/configuration/game/page.tsx` | `GAME` + frozen `Match` snapshot docs |
| **Module D: Financial Configuration** | `/configuration/financial` | `admin-web/src/app/(admin)/configuration/financial/page.tsx` | `FINANCIAL` & `TIERS` (Maker-Checker Restricted) |
| **Module E: KYC & Eligibility** | `/configuration/kyc` | `admin-web/src/app/(admin)/configuration/kyc/page.tsx` | `KYC` (Maker-Checker Restricted) |
| **Module F: Safer Play** | `/configuration/safer-play` | `admin-web/src/app/(admin)/configuration/safer-play/page.tsx` | `SAFER_PLAY` (Maker-Checker Restricted) |
| **Module G: Matchmaking** | `/configuration/matchmaking` | `admin-web/src/app/(admin)/configuration/matchmaking/page.tsx` | `MATCHMAKING` + `tierEnforcement.js` presets |
| **Module H: Feature Flags** | `/configuration/feature-flags` | `admin-web/src/app/(admin)/configuration/feature-flags/page.tsx` | `FeatureFlag` |
| **Module I: Notification Templates** | `/configuration/notifications` | `admin-web/src/app/(admin)/configuration/notifications/page.tsx` | `NotificationTemplate` |
| **Module J: Maintenance Controls** | `/configuration/maintenance` | `admin-web/src/app/(admin)/configuration/maintenance/page.tsx` | `MaintenanceState` |
| **Section 5: Version History & Diff** | `/configuration/versions` | `admin-web/src/app/(admin)/configuration/versions/page.tsx` | `PlatformConfigVersion` & `ConfigApproval` |
| **Section 6: Maker-Checker Approvals** | `/configuration/approvals` | `admin-web/src/app/(admin)/configuration/approvals/page.tsx` | `PlatformConfigVersion` & `ConfigApproval` |

---

## 3. API Integration Reference

All requests route through the centralized `apiClient` (`admin-web/src/lib/api/client.ts`) and `adminApi` (`admin-web/src/lib/api/admin.ts`):

### Configuration Versioning & Maker-Checker (`/api/v1/admin/config`)
- `GET /admin/config/active` — Retrieve active configuration version and canonical payload.
- `GET /admin/config/versions?page=&limit=&status=` — Paginated version history including `approvals`.
- `GET /admin/config/versions/:versionOrId` — Retrieve full version payload and SHA-256 checksum verification by version number or UUID.
- `POST /admin/config/drafts/validate` — Server-side dry-run validation returning `{ valid, checksum, isRestricted, modifiedDomains, errors }`.
- `POST /admin/config/drafts` — Create a new `DRAFT` version.
- `PATCH /admin/config/drafts/:id` — Update an un-submitted `DRAFT` version.
- `DELETE /admin/config/drafts/:id` — Discard an un-submitted `DRAFT` version.
- `POST /admin/config/drafts/:id/submit` — Transition `DRAFT -> PENDING_APPROVAL` (locks version as immutable).
- `POST /admin/config/versions/:id/approve` — Maker-Checker approval binding reviewer ID and SHA-256 `checksum`.
- `POST /admin/config/versions/:id/reject` — Maker-Checker rejection with mandatory `reason`.
- `POST /admin/config/versions/:id/activate` — Atomic activation superseding previous active version, syncing `PlatformSettings`, and enqueuing `platform.config.activated` outbox event.
- `POST /admin/config/versions/:id/rollback` — Non-destructive rollback staging historical payload as new sequential version `N+1` with `rolledBackFrom` pointer.

### Feature Flags (`/api/v1/admin/feature-flags`)
- `GET /admin/feature-flags` — List all feature flags with `adminVisibility` and `isProtectedInvariant` metadata.
- `GET /admin/feature-flags/:key` — Get single feature flag.
- `GET /admin/feature-flags/:key/history` — Paginated audit history from `AdminAuditLog`.
- `POST /admin/feature-flags/:key/evaluate` — Deterministic SHA-256 rollout cohort and tier evaluation.
- `POST /admin/feature-flags` — Create feature flag (`flags.manage`).
- `PATCH /admin/feature-flags/:key` — Update feature flag (`flags.manage`).
- `POST /admin/feature-flags/:key/toggle` — Toggle feature flag with mandatory reason (`flags.manage`).
- `POST /admin/feature-flags/:key/kill-switch` — Trip or restore operational kill switch (`flags.killswitch`).
- `DELETE /admin/feature-flags/:key` — Delete non-protected feature flag (`flags.manage`).

### Notification Templates (`/api/v1/admin/notification-templates`)
- `GET /admin/notification-templates/channels` — Retrieve honest runtime channel capabilities (`IN_APP`, `PUSH`, `EMAIL`).
- `GET /admin/notification-templates` — List notification templates.
- `GET /admin/notification-templates/:codeOrId` — Get single notification template.
- `GET /admin/notification-templates/:codeOrId/history` — Paginated version and audit history.
- `POST /admin/notification-templates/preview` — Server-side validation and HTML-escaped preview of draft template.
- `POST /admin/notification-templates/:codeOrId/preview` — Server-side preview of saved template.
- `POST /admin/notification-templates` — Create notification template at `version: 1` (`templates.manage`).
- `PATCH /admin/notification-templates/:codeOrId` — Update template and increment version `N+1` (`templates.manage`).

### Maintenance Controls (`/api/v1/admin/maintenance` & `/api/v1/maintenance/status`)
- `GET /admin/maintenance` — Get maintenance configuration and computed `effectiveStatus` (`INACTIVE`, `SCHEDULED`, `ACTIVE`, `EXPIRED`).
- `GET /admin/maintenance/history` — Paginated maintenance audit history.
- `POST /admin/maintenance/evaluate` — Simulate request access decision (`EXEMPT_PROTECTED_SURFACE`, `ADMIN_ROLE_BYPASS`, `ALLOWED_IP_BYPASS`, `MAINTENANCE_ACTIVE`).
- `PATCH /admin/maintenance` — Update maintenance settings (`maintenance.manage`).
- `POST /admin/maintenance/enable` — Enable or schedule maintenance mode (`maintenance.manage`).
- `POST /admin/maintenance/disable` — Disable maintenance mode (`maintenance.manage`).
- `POST /admin/maintenance/emergency-reset` — Immediate emergency recovery reset (`maintenance.manage`).

---

## 4. Permission & Action Matrix

| Permission / Capability | `SUPER_ADMIN` | `FINANCE` | `RISK_COMPLIANCE` | `GAME_OPERATIONS` | `SUPPORT` | `READ_ONLY_AUDITOR` |
|---|---|---|---|---|---|---|
| `config.read` (Inspect Config, History, Diffs, Templates) | Yes | Yes | Yes | Yes | No | Yes |
| `config.propose.financial` (`FINANCIAL`, `TIERS`, `PLATFORM`) | Yes | Yes | No | No | No | No |
| `config.propose.compliance` (`SAFER_PLAY`, `KYC`, `PLATFORM`) | Yes | No | Yes | No | No | No |
| `config.propose.game` (`GAME`, `MATCHMAKING`, `PLATFORM`) | Yes | No | No | Yes | No | No |
| `config.approve` (Maker-Checker Approve/Reject, `authorId !== reviewerId`) | Yes | Yes | Yes | No | No | No |
| `config.activate` (Atomic Activation & Rollback) | Yes | No | No | No | No | No |
| `flags.read` (View & Evaluate Feature Flags) | Yes | Yes | Yes | Yes | Yes | Yes |
| `flags.killswitch` (Trip/Restore Operational Kill Switches) | Yes | No | Yes | Yes | No | No |
| `flags.manage` (Create, Edit, Toggle, Delete Flags) | Yes | No | No | No | No | No |
| `templates.manage` (Create & Edit Notification Templates) | Yes | No | No | No | No | No |
| `maintenance.read` (Inspect Maintenance State & Evaluate) | Yes | Yes | Yes | Yes | Yes | Yes |
| `maintenance.manage` (Enable, Disable, Emergency Reset) | Yes | No | No | No | No | No |

---

## 5. Known Backend Capability Gaps & Honest UI Indicators

1. **Notification Delivery Providers (`PUSH` & `EMAIL`):**
   - `IN_APP` notifications are fully implemented (`Notification` table in PostgreSQL + real-time Socket.IO delivery via `outboxDrainer.js`).
   - `PUSH` notifications use a logged mock fallback (`[MOCK FCM]`) in `outboxDrainer.js` when a player has no active socket; no external Firebase Cloud Messaging SDK is wired.
   - `EMAIL` templates are supported for authoring, versioning, and previewing, but no external SMTP/email provider is wired.
   - The Notification Templates UI explicitly surfaces these statuses (`Implemented (Live)`, `Mock Fallback Only`, `Template-Only (No Provider)`).
2. **Matchmaking Discrete Stake Presets (`STAKE_PRESETS`):**
   - While tier minimum/maximum stake bounds (`tiers.AMATEUR`, `tiers.MASTER`, `tiers.PRO`) are dynamically configurable in `PlatformConfigVersion`, the 3 discrete Option A matchmaking bucket presets per tier in `backend/src/middleware/tierEnforcement.js` are code-defined constants validated against those DB bounds. The Matchmaking Configuration UI displays these discrete buckets as read-only reference alongside the editable `matchmaking` parameters.

---

## 6. Verification & Testing Summary

- **TypeScript (`npx tsc --noEmit`):** 0 errors.
- **ESLint (`npx eslint` on Configuration & Shell modules):** 0 errors, 0 warnings.
- **Frontend Unit, Component & API Integration Tests (`pnpm test`):** 18 passed, 0 failed.
- **Backend Unit & API Test Suites (`jest`):** 66 suites passed (614 tests passed), 0 failed.
- **Next.js Production Build (`pnpm build`):** Compiled and prerendered all 31 static/app routes cleanly.

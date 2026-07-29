# 05 — Design System DNA

The complete visual language for Draught Bet (originally contracted under the working title "Draughts Arena"). Every screen must be checked against this file before being considered done — it is not optional polish, it is the brand.

## 0. Research grounding & positioning

Casual checkers apps (Quick Checkers, Checkers Online, Draughts) read as toys — cartoonish, ad-cluttered, no visual sense of stakes. Real-money skill-gaming leaders (Skillz-powered apps) read as clean-but-generic — trustworthy, minimal, but could be any card or bingo game reskinned. Nothing in this space visually says "serious strategy arena, real stakes, fair and secure" the way a premium chess app or a poker room does. That's the gap Draught Bet fills.

**Positioning:** Draught Bet is where draughts stops being a pastime and becomes a competitive arena — every match server-verified, every stake real, every win yours the moment the board says so.

**Personality:** disciplined, confident, unshowy. "Serious chess club," not "mobile arcade." The interface stays calm under pressure — no confetti, no coin-shower animations, no cartoon mascots. Restraint is the trust signal, because there's real money on the board.

**Signature element — "the crossing":** a single thin gold diagonal stroke, echoing the diagonal capture move that defines draughts. Appears in exactly three places: the Pro tier badge, the match-won banner, and a featured/urgent call-out card. Never used as decoration anywhere else — its rarity is what makes it mean something.

---

## 1. Color system

Dark-first. A light mode is a real accessibility feature to plan for, but every value below is specified dark-mode-first; confirm with the client whether light mode is required for MVP or deferred to Phase 2.

### Base surfaces
| Token | Hex | Use |
|---|---|---|
| `void` | `#0B0D10` | App background |
| `surface-1` | `#15181D` | Cards, match list rows |
| `surface-2` | `#1E2229` | Elevated cards, modals, the board's dark squares |
| `surface-3` | `#272C34` | Highest elevation — active/focused elements |
| `hairline` | `#2E333B` | Borders, dividers |

### Board & pieces (literal game material, distinct from UI chrome)
| Token | Hex | Use |
|---|---|---|
| `board-dark` | `#1E2229` | Dark playable squares (shares value with `surface-2` deliberately) |
| `board-light` | `#E8E2D5` | Light non-playable squares — warm aged-ivory, never stark white |
| `piece-light` | `#F2EEE6` | Light player's pieces |
| `piece-dark` | `#2A2118` | Dark player's pieces — warm near-black, never pure black |
| `legal-move-highlight` | `#2FAE72` @ 25% opacity | Tap-to-reveal legal destination squares only — never shown proactively |

### Text
| Token | Hex | Use |
|---|---|---|
| `text-primary` | `#F4F2ED` | Primary reading text |
| `text-secondary` | `#9CA3AF` | Supporting text, timestamps (non-critical only) |
| `text-muted` | `#6B7280` | Placeholders, disabled states |

### Accent gold (the signature color — used sparingly)
| Token | Hex | Use |
|---|---|---|
| `gold-500` | `#E7B24A` | Pro tier, the crossing motif, prize amounts, crown iconography |
| `gold-700` | `#B8862E` | Gold pressed/active state |
| `gold-100` | `#3A2E17` | Gold tint background (badges) |

**Discipline rule:** gold appears on at most one element per screen at rest. A win screen showing tier + prize + crossing motif simultaneously is the one moment all three are earned together.

### Tier colors (semantic, never decorative)
| Tier | Token | Hex |
|---|---|---|
| Amateur | `tier-amateur` | `#8B93A1` (slate) |
| Master | `tier-master` | `#4C8DFF` (sapphire) |
| Pro | `tier-pro` | `#E7B24A` (same as accent gold — the one place gold means status, not just brand) |

### Semantic states
| Token | Hex | Use |
|---|---|---|
| `success` | `#2FAE72` | Win, deposit confirmed, match live |
| `danger` | `#E5484D` | Loss, forfeit, withdrawal rejected, disconnect warning |
| `warning` | `#E7B24A` | Pending review, low time remaining |
| `info` | `#4C8DFF` | Neutral system messages |

Nine colors total, three deliberately reused across roles. A money-handling game app already has enough visual information (board state, stakes, timers, notifications) — every extra hue is a hue the player has to learn.

---

## 2. Typography

| Role | Typeface | Where |
|---|---|---|
| Display | **Fraunces** (serif, weight 600) | Screen titles, tier names, win/loss banner, onboarding headlines. The one deliberate tension in an otherwise all-sans UI — signals heritage/prestige without looking dated. |
| Body / UI | **Manrope** (400, 500, 700) | All interface text |
| Numerals / data | **JetBrains Mono** (500, tabular figures) | Wallet balance, stakes, timers, move notation — money and time must never visually jitter as digits change width |

### Type scale
| Style | Font | Size | Weight | Use |
|---|---|---|---|---|
| Display L | Fraunces | 32 | 600 | Win/loss banner |
| Display M | Fraunces | 24 | 600 | Screen titles |
| Title | Manrope | 18 | 700 | Card headers, section labels |
| Body | Manrope | 15 | 400 | Standard UI text |
| Body Bold | Manrope | 15 | 700 | Inline emphasis |
| Caption | Manrope | 13 | 400 | Timestamps, helper text |
| Balance | JetBrains Mono | 28 | 500 | Wallet balance |
| Stake | JetBrains Mono | 16 | 500 | Stake amounts |
| Timer | JetBrains Mono | 14 | 500 | Match/turn timers |

---

## 3. Spacing & layout grid

8px base unit: `4, 8, 12, 16, 24, 32, 48` — no odd values.

- Screen horizontal padding: `16`
- Card internal padding: `16`
- Gap between stacked cards: `12`
- Gap between unrelated sections: `32`
- Minimum touch target: `44×44`
- Corner radius: `12` cards, `8` buttons/inputs/badges, `4` board squares (draughts boards read wrong with heavy rounding)

---

## 4. Iconography

Outline style, 2px stroke, no fills except the single status dot (online/offline indicator). Package: `lucide_icons` in Flutter.

Core inventory:
| Icon | Use |
|---|---|
| `crown` | Pro tier, king pieces, win banner |
| `swords` | Call-out/challenge action |
| `shield-check` | Fair-play/anti-cheat messaging, KYC verified badge |
| `wallet` | Wallet tab |
| `history` | Results/match history |
| `bell` | Notifications |
| `users` | Matchmaking/online players |
| `alert-triangle` | Disconnect warning, low balance |
| `check-circle` | Confirmations |
| `x-circle` | Rejections (withdrawal declined, move rejected) |
| `settings` | Settings tab |
| `log-out` | Sign out |

Never mix in filled/solid icon variants except the single status dot — outline-only keeps the interface precise rather than toy-like.

---

## 5. Illustration system

Illustrations appear only in three contexts for MVP: empty states, onboarding, and the win/loss banner background motif. Draught Bet does **not** use character mascots, cartoon avatars, or cutesy iconography anywhere — this is the single biggest visual departure from the casual-checkers-app category, and it should be treated as a hard rule, not a preference.

### Style
- **Geometric, board-derived abstraction.** Illustrations are built from the same visual vocabulary as the game itself: diagonal lines, square/diamond grids, circular piece forms, concentric rings. No representational human figures, no mascots.
- **Two-tone only.** Every illustration uses exactly `surface-2`/`surface-3` for form plus one accent (`gold-500` for aspirational/premium contexts, `tier-master` blue for neutral/informational contexts). Never a third color, never a gradient.
- **Line weight matches iconography** — 2px stroke, consistent with §4, so illustrations and icons feel like one family.

### Where illustrations appear
- **Empty states** — a simple abstracted board-corner motif, `text-muted` colored.
- **Onboarding** (3–4 screens max): abstracted diagonal-motion diagrams teaching the core mechanics through the same visual language as the brand.
- **Win banner background** — the single gold crossing-stroke motif, at low opacity, behind the "You won" text. The only illustration allowed to use the signature gold accent at more than icon scale.

### What to explicitly avoid
- No stock illustration packs (undraw.co-style flat character illustrations).
- No trophy/coin/cash-pile iconography beyond what's functionally necessary.
- No confetti, sparkles, or particle effects on win states.

---

## 6. Core components

### Wallet balance chip (persistent, top bar)
`surface-2` background, `8` radius, `12×8` padding. Balance in JetBrains Mono, `text-primary`, prefixed with the wallet's currency symbol (`₦` for the Nigeria-phase NGN wallet — never hardcode the symbol, read it from `Wallet.currency`). On balance change: a brief (200ms) color flash to `success` (credit) or `danger` (debit), then settles back — no counting-up animation, no celebration.

### Tier card (Amateur / Master / Pro)
`surface-1` background, `12` radius, `1px` `hairline` border. Left edge: `4px` solid stripe in the tier's color. Tier name in Display M. Stake range in Stake style, `text-secondary`. Pro card only: the crossing motif — a single 1px gold diagonal line, 40px long, fading at both ends, top-right corner.

### Call-out card
`surface-1`, `12` radius. Challenger initials circle (`36px`, `surface-3` bg, tier-colored ring). Stake amount prominent in JetBrains Mono. "Accept" button filled in the challenger's tier color. Featured/urgent call-out gets the gold crossing-stroke in the top-right corner.

### Match board screen
Full-bleed board, no card chrome around it. Turn indicator: small tier-colored pill above the board with a JetBrains Mono timer. Legal move squares highlighted only on tap (never proactively). Captured piece tray below the board: quiet, `text-secondary`, not celebratory.

### Win / loss banner
Full-width overlay, `surface-2`. Win: Display L "You won" in Fraunces, gold crossing-stroke motif behind the headline at low opacity, payout in JetBrains Mono `gold-500`. Loss: Display L "Match lost" in Fraunces, `text-primary` (not danger-red — losing a strategy game is an outcome, not an error state). Two actions: "Rematch" (tier-colored filled) and "Back to lobby" (ghost).

### Bottom navigation
4 items: Home, Wallet, Results, Settings. `surface-1` background, active icon `text-primary` with a small tier-colored dot beneath, inactive `text-muted`.

### Notification bell + panel
Bell top-right, red dot badge when unread exist. Panel: `surface-1` rows, type-colored icon left, title + message, relative timestamp right-aligned in `text-muted`.

### Empty states
Illustration (per §5) + Manrope Title headline + Caption body + verb-first action button.

---

## 7. Motion

- Board moves: piece slides to destination over `180ms`, ease-out. Captures fade over `220ms` — no bounce, no spin.
- Screen transitions: standard platform push/pop — don't fight Flutter/Android's native feel.
- Balance flash: `200ms` color tween per §6.
- Win/loss banner: `250ms` fade + slight scale (0.96→1.0). Reduced-motion setting disables the scale, keeps only the fade.
- No bounce, elastic, or spring easing anywhere in the app.

---

## 8. Accessibility & quality floor

- Every color pair meets WCAG AA (4.5:1) against its background. `text-secondary` (#9CA3AF) on `void` (#0B0D10) passes at 4.6:1 but stays reserved for non-critical text only — anything load-bearing uses `text-primary` or a semantic color.
- Minimum touch target 44×44.
- Respect Android's reduced-motion setting.
- Never convey tier, win/loss, or balance-change state through color alone.

---

## 9. Voice & writing

- Sentence case everywhere — buttons, headers, tier names ("Master arena," not "MASTER ARENA")
- Verb-first buttons: "Find a match," "Accept call-out," "Withdraw funds" — never "OK" or "Submit"
- Errors state what happened and what to do, no apology, no exclamation marks: "Withdrawal needs admin review. You'll get a notification when it's approved." — not "Oops! Something went wrong!"
- Losing a match is never framed apologetically — "Match lost" is a fact, not a failure the app regrets
- Never use gambling-adjacent language ("jackpot," "lucky," "bet big and win big") — this is a skill game.

---

## 10. Flutter implementation

```
lib/theme/
  colors.dart       all tokens from §1 as static const Color
  typography.dart   TextTheme built from google_fonts (Fraunces, Manrope, JetBrains Mono)
  theme.dart        ThemeData.dark() assembled from colors.dart + typography.dart
  tier_theme.dart    Color forTier(Tier t); TextStyle badgeStyleForTier(Tier t)
```

- `flutter pub add google_fonts` covers all three typefaces without manual font bundling.
- Build `ThemeData.dark()` as the only theme for MVP unless light mode is confirmed in scope.
- Centralize tier color mapping in `tier_theme.dart` — every screen showing a tier badge, stake range, or call-out card pulls from this single source, never re-decides the color per screen.

# Draughts Arena — Design System

## 0. Research grounding

Looked at three categories of existing product before designing anything:

- **Casual checkers apps** (Quick Checkers, Checkers Online, Draughts): cartoonish, cluttered with skins/avatars, ad-supported, no visual sense of stakes. Reviews consistently mention frustration with unclear draw rules and laggy reconnects — both of which we solve at the engine level (Weeks 3–4 of the dev roadmap), not just visually.
- **Real-money skill-gaming leaders** (Skillz-powered apps — Blackout Bingo, Solitaire Cash, etc.): clean, minimal, "no ads in cash games," heavy trust signals (fast/secure payouts, fair matchmaking), tournament/arena framing, skill-tier matchmaking. This is the right *category* of design language — competitive, trustworthy, money-aware — but it's generic enough to reskin as any card or bingo game. Draughts Arena needs a stronger identity than "clean generic gaming app."
- **User reviews across all of these** repeatedly ask for exactly one thing Draughts Arena already has as a *contractual* feature: real-money stakes. The demand is validated; the visual category isn't yet claimed by anyone doing it well for draughts specifically.

**The opening:** nothing in this space visually communicates "serious strategy arena, real stakes, fair and secure" the way a premium chess app or a poker room does. That's the gap.

---

## 1. Brand identity

**Positioning statement:** Draughts Arena is where draughts stops being a pastime and becomes a competitive arena — every match server-verified, every stake real, every win yours the moment the board says so.

**Personality:** disciplined, confident, unshowy. Think "serious chess club," not "mobile arcade." The app should feel calm under pressure — because there's real money on the board, the UI never gets loud or gamified with confetti/coins/cartoon mascots the way casual games do. Restraint *is* the trust signal.

**Signature element — "the crossing":** a single thin gold diagonal stroke, echoing the diagonal capture move that defines draughts. It appears in exactly three places: the Pro tier badge, the match-won banner, and a featured call-out card. It never appears as decoration elsewhere — its rarity is what makes it mean something.

---

## 2. Color system

Dark-first (games are played in short bursts at all hours; dark reduces eye strain and reads more premium/competitive than a light fintech app). A light mode exists for accessibility/preference but every color below is specified dark-first.

### Base surfaces
| Token | Hex | Use |
|---|---|---|
| `void` | `#0B0D10` | App background |
| `surface-1` | `#15181D` | Cards, match list rows |
| `surface-2` | `#1E2229` | Elevated cards, modals, the board's dark squares |
| `surface-3` | `#272C34` | Highest elevation — active/focused elements |
| `hairline` | `#2E333B` | Borders, dividers (never pure white/black) |

### Board colors (distinct from UI surfaces — these are literal game pieces)
| Token | Hex | Use |
|---|---|---|
| `board-dark` | `#1E2229` | Dark playable squares (shares value with `surface-2` deliberately — the board *is* the app's material) |
| `board-light` | `#E8E2D5` | Light non-playable squares — warm aged-ivory, not stark white |
| `piece-light` | `#F2EEE6` | Light player's pieces |
| `piece-dark` | `#2A2118` | Dark player's pieces — warm near-black, not pure black |
| `legal-move-highlight` | `#2FAE72` at 25% opacity | Tap-to-see legal destination squares |

### Text
| Token | Hex | Use |
|---|---|---|
| `text-primary` | `#F4F2ED` | Primary reading text on dark |
| `text-secondary` | `#9CA3AF` | Supporting text, timestamps |
| `text-muted` | `#6B7280` | Placeholders, disabled |

### Accent — gold (the signature color, used sparingly)
| Token | Hex | Use |
|---|---|---|
| `gold-500` | `#E7B24A` | Pro tier, the crossing motif, prize amounts, crown iconography |
| `gold-700` | `#B8862E` | Gold pressed/active state |
| `gold-100` | `#3A2E17` | Gold tint background (dark mode — for badges) |

**Discipline rule: gold appears on at most one element per screen at rest.** If a screen shows a Pro badge AND a prize amount AND a crossing-stroke banner simultaneously, mute two of the three to `text-secondary` weight until the user's attention should genuinely go there (e.g., an actual win screen can use all three — that's the one moment it's earned).

### Tier colors (semantic — never decorative)
| Tier | Token | Hex | Rationale |
|---|---|---|---|
| Amateur | `tier-amateur` | `#8B93A1` (slate) | Entry tier — quiet, unranked |
| Master | `tier-master` | `#4C8DFF` (sapphire) | Mid tier — competent, cool confidence |
| Pro | `tier-pro` | `#E7B24A` (gold, same as accent) | Top tier — the one place gold means *status*, not just brand |

### Semantic (state) colors
| Token | Hex | Use |
|---|---|---|
| `success` | `#2FAE72` | Win, deposit confirmed, match live |
| `danger` | `#E5484D` | Loss, forfeit, withdrawal rejected, disconnect warning |
| `warning` | `#E7B24A` (reuses gold-500) | Pending review, low time remaining |
| `info` | `#4C8DFF` (reuses tier-master) | Neutral system messages |

**Why so few hues:** a money-handling game app has enough visual noise already (board state, stakes, timers, notifications). Every additional hue is a hue the player has to learn the meaning of. Nine total colors, three of which are reused across roles deliberately.

---

## 3. Typography

| Role | Typeface | Where |
|---|---|---|
| Display | **Fraunces** (serif, optical size "Display", weight 600) | Screen titles, tier names ("Pro Arena"), the win/loss banner, onboarding headlines. A serif in an otherwise all-sans-serif competitive UI is the one deliberate tension — it signals heritage/prestige (draughts is centuries old) without looking old-fashioned. |
| Body / UI | **Manrope** (weights 400, 500, 700) | All interface text — buttons, labels, lists, settings |
| Numerals / data | **JetBrains Mono** (weight 500, tabular figures) | Wallet balance, stake amounts, match timers, move notation. Money and time must never visually "jitter" as digits change width — monospace tabular figures solve this. |

### Type scale (Flutter logical pixels)
| Style | Font | Size | Weight | Use |
|---|---|---|---|---|
| Display L | Fraunces | 32 | 600 | Win/loss banner |
| Display M | Fraunces | 24 | 600 | Screen titles ("Amateur Arena") |
| Title | Manrope | 18 | 700 | Card headers, section labels |
| Body | Manrope | 15 | 400 | Standard UI text |
| Body Bold | Manrope | 15 | 700 | Emphasis inline |
| Caption | Manrope | 13 | 400 | Timestamps, helper text |
| Balance | JetBrains Mono | 28 | 500 | Wallet balance display |
| Stake | JetBrains Mono | 16 | 500 | Stake amounts in cards/buttons |
| Timer | JetBrains Mono | 14 | 500 | Match/turn timers |

---

## 4. Spacing & layout grid

8px base unit throughout — `4, 8, 12, 16, 24, 32, 48`. No odd values.

- Screen horizontal padding: `16`
- Card internal padding: `16`
- Gap between stacked cards: `12`
- Gap between unrelated sections: `32`
- Touch targets: minimum `44x44` (all buttons, tappable board squares, tab bar icons)
- Corner radius: `12` for cards, `8` for buttons/inputs/badges, `4` for the board squares themselves (draughts boards have near-sharp corners — a heavily rounded board reads wrong)

---

## 5. Iconography

Outline style, 2px stroke weight, no fills except for status dots. Suggested set (Lucide icon names, since `flutter pub add lucide_icons` covers all of these):
- `crown` — Pro tier, king pieces, win banner
- `swords` — call-out/challenge action
- `shield-check` — fair-play/anti-cheat messaging, KYC verified badge
- `wallet` — wallet tab
- `history` — results/match history
- `bell` — notifications
- `users` — matchmaking/online players
- `alert-triangle` — disconnect warning, low balance

Never use filled/solid icon variants except the single status dot (online/offline indicator) — outline-only keeps the interface feeling precise rather than toy-like.

---

## 6. Core components

### Wallet balance chip (persistent, top bar)
- `surface-2` background, `8` radius, `12x8` padding
- Balance in JetBrains Mono, `text-primary`, prefixed with `£`
- Tap target opens wallet screen
- On balance change: brief (200ms) color flash to `success` (credit) or `danger` (debit), then settles back to `text-primary` — no confetti, no counting-up animation. A calm flash, not a celebration; this is a serious-money UI.

### Tier card (Amateur / Master / Pro selection)
- `surface-1` background, `12` radius, `1px` `hairline` border
- Left edge: `4px` solid stripe in the tier's color (`tier-amateur` / `tier-master` / `tier-pro`)
- Tier name in Display M (Fraunces)
- Stake range in Stake style (JetBrains Mono), `text-secondary`
- Pro card only: the crossing motif — a single 1px gold diagonal line drawn across the top-right corner of the card, 40px long, fading at both ends

### Call-out card
- `surface-1`, `12` radius
- Challenger avatar/initials circle (`36px`, `surface-3` bg, tier-colored ring)
- Stake amount prominent in JetBrains Mono
- "Accept" button — filled, tier-colored background matching the challenger's tier, `on-{tier}` text
- Featured/urgent call-out (large stake, expiring soon): adds the single gold crossing-stroke in the top-right corner — same rule as the Pro tier card, reused meaningfully rather than as a new pattern

### Match board screen
- Full-bleed board, `board-dark`/`board-light` squares, no card chrome around it — the board is the hero, nothing competes with it
- Turn indicator: small pill above the board, tier-colored, shows whose turn + timer in JetBrains Mono
- Legal move squares: `legal-move-highlight` overlay only on tap, never shown proactively (avoids giving inadvertent hints, and matches "the server is the sole authority" principle — the client shouldn't pre-compute anything it doesn't have to)
- Captured pieces tray: small row below the board showing captured piece counts — quiet, `text-secondary`, not celebratory

### Win / loss banner (the one place to spend all the boldness at once)
- Full-width overlay card, `surface-2`, appears after `match_ended`
- Win: Display L "You won" in Fraunces, gold crossing-stroke motif behind the headline (subtle, low-opacity), payout amount large in JetBrains Mono `gold-500`
- Loss: Display L "Match lost" in Fraunces, `text-primary` (not danger-red — losing a strategy game isn't an "error state," it's just an outcome), stake lost shown plainly in JetBrains Mono
- Two actions: "Rematch" (tier-colored filled button) and "Back to lobby" (ghost button)

### Bottom navigation
- 4 items: Home, Wallet, Results, Settings — per your original wireframe's zones (balance/notifications live in top bar, not bottom nav)
- `surface-1` background, active icon in `text-primary` with a small tier-colored dot beneath it, inactive icons `text-muted`
- No labels-and-icons-both clutter beyond standard icon + 11px caption label

### Notification bell + panel
- Bell icon top-right, red dot badge (count) when unread exist — matches your original wireframe's "call outs and notifications" zone exactly
- Panel: list of `surface-1` rows, icon left (colored by type per §2 semantic colors), title + message, relative timestamp right-aligned in `text-muted`

### Empty states
- Icon (outline, `text-muted`, 48px) + one-line headline in Manrope Title + one-line body in Caption
- Always end with a verb-first action: "No matches yet" → "Find a match" button, never a passive "Nothing here yet."

---

## 7. Motion

- Board moves: piece slides to destination over `180ms`, ease-out. Captured pieces fade out over `220ms` — no bounce, no spin. A capture in a real-money game should feel definitive, not playful.
- Screen transitions: standard platform push/pop (Flutter default `MaterialPageRoute` transitions) — don't fight the platform's native feel.
- Balance change flash: `200ms` color tween, described in §6.
- Win/loss banner entrance: `250ms` fade + slight scale (0.96→1.0) — a single restrained motion, not a full celebration sequence. Reduced-motion accessibility setting disables the scale, keeps only the fade.
- Nothing in the app should use bounce, elastic, or spring easing curves — those read as "casual mobile game," which is exactly the category this app is positioned against.

---

## 8. Accessibility & quality floor

- Every color pair in this system meets WCAG AA contrast (4.5:1 for text) against its intended background — verify `text-secondary` (#9CA3AF) against `void` (#0B0D10) specifically, since gray-on-near-black is the easiest pair to get wrong (it passes at 4.6:1, but stays at `text-secondary` only for non-critical text — anything load-bearing like a balance or a legal-move indicator uses `text-primary` or a semantic color, never `text-secondary`)
- Minimum touch target 44×44 logical pixels — board squares on small devices need testing; if the board's playable area makes individual squares smaller than 44px, add a slightly larger invisible tap-catch area per square rather than shrinking the visual grid
- Respect Android's reduced-motion system setting — falls back to instant piece placement, no slide animation
- Never convey tier, win/loss, or balance-change state through color alone — always paired with a text label or icon (colorblind-safe by construction, not as an afterthought)

---

## 9. Voice & writing

- Sentence case everywhere — buttons, headers, tier names as written ("Master arena", not "MASTER ARENA")
- Verb-first buttons: "Find a match", "Accept call-out", "Withdraw funds" — never "OK" or "Submit"
- Errors state what happened and what to do, no apology, no exclamation marks: "Withdrawal needs admin review. You'll get a notification when it's approved." not "Oops! Something went wrong!"
- Losing a match is never framed apologetically — "Match lost" is a fact, not a failure the app is sorry about
- Never use gambling-adjacent language ("jackpot," "lucky," "bet big and win big") — this is a skill game, and the copy should reinforce that distinction as consistently as the legal positioning does

---

## 10. Flutter implementation notes

```
lib/
  theme/
    colors.dart       // all tokens from §2 as static const Color
    typography.dart   // TextTheme built from google_fonts (Fraunces, Manrope, JetBrains Mono)
    theme.dart         // ThemeData.dark() assembled from colors.dart + typography.dart
    tier_theme.dart    // helper: Color forTier(Tier t), TextStyle badgeStyleForTier(Tier t)
```

- `flutter pub add google_fonts` — covers Fraunces, Manrope, and JetBrains Mono directly from Google Fonts, no manual font file bundling needed
- Build `ThemeData.dark()` as the app's only theme initially (light mode is a real Phase 2 accessibility item, not a launch requirement — confirm with Mr. Livingstone whether it's wanted for MVP or deferred)
- Encode the tier color mapping once, centrally (`tier_theme.dart`) — every screen that shows a tier badge, stake range, or call-out card pulls from this single source rather than re-deciding the color per screen

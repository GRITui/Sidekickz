# Handoff: Sidekick — Task Flow, Home "Today", More/Settings & Calendar Refinements

## Overview
This package documents a set of UX refinements to **Sidekick** (repo: `GRITui/Sidekickz`, a local-first mobile-web business assistant for solo service providers — personal trainers, real-estate agents, etc.). The refinements came out of a multi-agent assessment loop that ranked the app's functional surfaces by user friction, mobile ergonomics (44px+ targets), and feature discoverability, then rebuilt the top candidates as an interactive prototype.

Five surfaces were refined, all in one prototype file (`More 1a.dc.html`):

1. **More/Settings** — restructured from 12 collapsible sections into 3 groups (Tools grid, "Set up your business" drill-ins, Preferences)
2. **Home** — three competing urgency surfaces merged into one "Today" stack
3. **Job modal** — Quick log / Full details split with live net-take math
4. **Task flow (pipeline)** — 4 client paths per card (advance / redo / postpone / cancel), stage-gate date booking, incident notes, and multi-session package delivery with a renewal loop
5. **Calendar** — 3-day mobile view with ergonomic touch targets

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, NOT production code to copy directly. The task is to **recreate these designs inside the existing Sidekickz codebase** (`app/` — vanilla JS modules + a single `styles.css`, local-first, no framework), following its established patterns: module files per surface, class-based CSS with the existing token set, bottom-sheet modals, and localStorage persistence. Do not introduce a framework; extend the existing vanilla architecture.

The prototype's inline styles use literal values that all trace back to tokens in `app/styles.css` — map them back to `var(--*)` when implementing (see Design Tokens).

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and copy are final and lifted from the production stylesheet. Recreate pixel-perfectly using the codebase's existing classes where they exist (`.list-card`, `.settings-row`, `.chip`, `.seg`, bottom-sheet modal shell) and extend them where new patterns are introduced (stage-gate card, package progress bar, pending-date banner).

## Screens / Views

### 1. Home — "Today" stack
- **Purpose**: One prioritized list replaces the previous three urgency surfaces (`home-alert-card`, `attn-card` "Needs attention", "Up next").
- **Layout**: Header greeting (22px/800, subtitle 13px `--muted`) → earnings hero card overlapping header by -28px (white `#FDFCFA`, radius 16, ฿ figure 40px/800 Spline Sans Mono, 3-col stats grid) → "Today" section label (14px/800) → one list-card.
- **Today list-card**: rows 14px padding, 0.5px `#DDD9CF` separators. Each row: 38px icon tile (radius 11; amber `#FAF3E7` tint for warnings, green `#E7EEEA` otherwise) + title 15px/700 + sub 12px `--muted` + right accessory (status pill or mono amount; overdue amounts in `#B4543E`).
- **Row types shown**: package renewals warning (pill "Renew", amber), overdue invoice (amount right, red), next booking (pill "Booked", green).
- **Quick links**: 2-col grid of outline buttons (Invoices, Documents).
- **FAB**: 58px circle, `#1A2421`, bottom-right above nav, opens the job modal.

### 2. Job modal — "Add session"
- **Purpose**: Highest-frequency action. Splits the old ~2.5-screen sheet into a fast path and a full path.
- **Shell**: bottom sheet, radius 22 top, drag handle 42×4px `#C8C3B7`, max-height 92vh, scrim `rgba(0,0,0,.5)`, tap-outside closes.
- **Segmented control**: "Quick log / Full details" — track `#DDD9CF` radius 11 padding 3px; active segment `#FDFCFA`, text `--brand`, shadow `0 1px 3px rgba(0,0,0,.12)`.
- **Quick log**: one field card (Date; Client with package chip "PKG 7/10"; Fee | Tip 2-col grid). Field labels 11px/700 uppercase `--muted`, values 16px (mono for numbers).
- **Full details adds**: Expense | Sessions grid, Notes textarea, and a drill-row card: "Plan & payments · 2 steps · 1 milestone ›", "Items on this engagement · 1 ›", "Time tracking · 0:00 ›" (each opens its own sub-view; collapsed rows show counts).
- **Net take box**: `#E7EEEA` bg, 1px `rgba(34,85,75,.25)` border, radius 11 — "Net take" 14px/700 brand + amount 26px/800 mono. **Live-computed: fee + tip − expense.**
- **Actions**: full-width "Save session" (brand solid, 16px padding). **Cancel is a plain text button** (14px/700 `--muted`, no border) — deliberately de-escalated from the old danger styling.

### 3. Task flow (pipeline)
- **Purpose**: Kanban-style pipeline. Stages: Inquiry → Quote → Booked → Deliver (+ hidden `lost`/`done` states).
- **Header**: "Task flow" + right-aligned mono counter "N active · M lost".
- **Chip rail**: horizontal scroll (scrollbar hidden), one chip per stage: pill 8×14px padding, count badge inside; selected = brand solid. **Progress underline** under each chip (4px tall, radius 3): green `#2F6D64` = stages before the selected one, marigold `#C08A3E` = selected, `#DDD9CF` = after. This replaces the old separate minimap.
- **Card** (radius 13, 1px `#DDD9CF`, shadow `0 1px 2px rgba(16,24,40,.05)`, padding 11×12px):
  - Title 14px/700, sub 11.5px `--muted`
  - Optional italic note line: `✎ "reason text"` 11.5px `#8A8579`
  - Optional badges row: "↻ Attempt N" pill (green tint, shown when attempt > 1); deadline chip
  - **Deadline chip is a button**: "Follow up by Jul 28 · postpone ↻" — amber `#FAF3E7`/`#8A5E22`; flips to red tint `rgba(180,84,62,.16)`/`#B4543E` with "Overdue — Jul 20" when past today. Tapping opens the postpone gate.
  - **Pending banner** (when card has no due date): full-width amber button at top of card — "⚠ No date booked for this stage — tap to book" — opens the book gate.
  - **Package progress** (package cards only): "Package sessions  1 / 8" label + 8px progress bar (`#DDD9CF` track, `#2F6D64` fill, radius 5).
  - **Action row** (flex, gap 8): `Cancel` (solid red `#B4543E`, white text — tweakable to a quiet gray "Lost" variant) · `↻ Redo` (outline gray, brand on hover) · primary advance button (flex:1, brand solid, 13px/800).
- **Advance button labels**: Inquiry "Send quote →" · Quote **"Client accepted →"** (renamed from "Mark booked" — label the client event, not the board mechanic) · Booked "Start delivery →" · Deliver "Complete ✓", or for package cards "Log session N of M →" / "Log final session ✓".

#### Stage-gate (inline confirm card)
Appears inside the card replacing the action row: 1.5px brand border, radius 11, title 13px/800 + context 12px `--muted`, centered date input (mono, brand border), optional note input, then two buttons (outline secondary + solid primary). Variants:

| Trigger | Title / context | Inputs | Primary | Secondary |
|---|---|---|---|---|
| Inquiry → Quote | "Book the follow-up" / quote validity deadline explainer | date | Book & move | Skip |
| Quote → Booked | "Client accepted 🎉" / pick the session date | date | Book & move | Skip |
| Booked → Deliver | "Book the hand-off" | date | Book & move | Skip |
| Redo | "Redo this step" / response didn't fit | date + note | Save date | Skip |
| Postpone | "Postpone" / client asked to move it | date + note | Rebook | Skip |
| Cancel | "Cancel this job" / note helps spot patterns | note only | **Cancel job** (red) | Keep it |
| Pending banner | "Book the next step" | date | Book date | Skip |
| Package session | "Session delivered ✓" / book next now | date | Book next session | Skip |
| Package final | "Final session — package complete 🎉" / renew without a gap | date | Send renewal quote | Just complete |

Default date = today + 7 days. Skip on a move-gate still moves the card but leaves it date-less → pending banner appears.

#### Behavior rules
- **Redo**: increments `attempt`, stays in stage, optionally books revised-attempt date, saves note.
- **Cancel**: sets stage `lost` (off board, counted in header), saves note.
- **Package session log**: increments `pkg.used`, books next session date (or pending banner).
- **Send renewal quote**: marks package card `done` AND spawns a new card in Quote — "«Client» — renewal · 8-session package", due = chosen date.
- Notes are optional everywhere; trimmed; displayed on card until next gate opens.

### 4. Calendar — 3-day view
- **Purpose**: Mobile ergonomics fix — old 7-day grid had 76px columns and sub-44px blocks.
- **Controls row**: "3-day / Month" pill segmented control + `‹` `Today` `›` pager (36px square buttons, `#E7EEEA` bg, brand text, radius 9). Pager shifts by 3 days.
- **Grid**: 44px time gutter + 3 equal day columns. Day header: 10px/700 day name + 24px date circle (today = brand solid circle, white number; today column tinted `rgba(231,238,234,.4-.65)`, weekend `rgba(221,217,207,.22-.4)`). Hour rows **72px** (was 60), labels 10px mono-ish right-aligned. Hours 08:00–12:00 in the prototype; production should render the full day.
- **Event blocks**: absolute-positioned, left/right 4px, **62px tall for 1h** (≥44px minimum always), radius 8, `#E7EEEA` bg, 3px `#2F6D64` left border, time 10px/800 mono brand, title 12.5px/700 ellipsized.
- **Breakpoint**: keep the 7-day grid at ≥900px; 3-day is the mobile default.

### 5. More / Settings
- **Purpose**: Discoverability fix — was 12 collapsible sections with 3 whole modules buried under "More tools"; now 3 flat groups, everything ≤1 tap deeper.
- **Account card**: avatar 40px brand circle + name/persona + `›`.
- **Tools grid** (2×2 tile grid, gap 10): tiles radius 11, 34px icon square (`#E7EEEA` tint, radius 10, brand stroke icons), name 14px/700, status sub-line 11px. Follow-ups tile carries a marigold count badge (16px pill, `#C08A3E`/`#2B1F0D`) + "3 due today" in marigold. Tiles: Follow-ups, Portfolio, Research, Insights.
- **"Set up your business"** list-card, 4 drill-in rows with sub-labels and **status accessories**: Business & documents ›; Payments & shop [amber "Set up" pill]; LINE & team [green "Connected" pill]; Data & backup ["2d ago"].
- **Preferences** list-card: Theme (Light/Dark/Auto segmented control, same pattern as job modal), Language, Currency, Monthly income goal (mono value).
- **About card**: Total jobs, Version (mono values). Then full-width outline **Log out** (1.5px `#B4543E` border, red text).
- **Drill-in sub-pages** (Business & documents · Payments & shop · LINE & team · Data & backup): header = 40px brand circle back button `‹` + 20px/800 title; content reuses list-card rows, labeled inputs (bg `#F0EEE8`, border `#DDD9CF`, radius 9, right-aligned), and helper paragraphs 12px `--muted`. Data & backup: 2-col grid of outline export buttons + info banner (green tint).

### Bottom navigation (all screens)
Fixed, `rgba(253,252,250,.92)` + `backdrop-filter: blur(20px)`, 0.5px top border. 5 tabs (Home, Task flow, Clients, Calendar, More): 24px stroke icon + 10px/600 label, min-height 52px; active = brand color, inactive `#5A5F58`.

## Interactions & Behavior
- Navigation: tab switching resets scroll to top. Prototype pages: home / flow / cal / root(More) / 4 drill-ins. Clients tab and Month view are **not designed** — keep existing production behavior.
- Toast: dark pill (`#1A2421`, radius 22) above the nav, fade+rise 300ms, auto-dismiss 1800ms. Used for all confirmations ("Session saved — ฿1,200 net", "Postponed to Jul 29", "Package complete — renewal card in Quote").
- Job modal: opens from FAB; scrim tap or Cancel closes; Save closes + toasts computed net.
- All gate mutations are single-tap + optional inputs; no gate requires more than one decision.
- Persistence: wire all state (jobs, stages, attempts, notes, due dates, pkg counters, settings) into the app's existing localStorage store.

## State Management
Job entity additions (extend the existing job record):
```
stage: 'inquiry' | 'quote' | 'booked' | 'deliver' | 'lost' | 'done'
due: ISO date | null        // next follow-up / session / deadline
attempt: number (default 1) // incremented by Redo
note: string | null         // last incident note (cancel/redo/postpone)
pkg: { used: number, total: number } | null  // multi-session packages
```
Transient UI state: selected stage chip, open gate `{jobId, kind, date, note}`, modal open/tab, fee/tip/expense strings, calendar dayOffset, theme.

Derived: net = fee + tip − expense; chip counts per stage; active = jobs not lost/done; overdue = due < today.

## Design Tokens
All from `app/styles.css` — use the existing `var(--*)` names:
- `--brand #22554B` (primary), `--brand-2 #2F6D64` (progress/accents), `--marigold #C08A3E` (current-stage, count badges), `--danger #B4543E`
- Surfaces: `--paper #F7F6F2` (bg), `--card #FDFCFA`, `--wash #F0EEE8` (inputs), `--line #DDD9CF` (borders/tracks), ink `#1A2421`, `--muted #5A5F58`, faint `#8A8579`
- Tints: green `#E7EEEA`, amber `#FAF3E7` / text `#8A5E22`, success `#3E7C4F` on `rgba(62,124,79,.16)`, danger tint `rgba(180,84,62,.16)`
- Radii: 16 (cards/hero), 13 (pipeline cards), 11 (list-cards, buttons, inputs, gates), 9 (small buttons/inputs), 999 (pills)
- Type: **Schibsted Grotesk** (UI; variable 400–900), **Spline Sans Mono** (all numbers, dates, amounts, counters)
- Shadows: cards `0 1px 2px rgba(16,24,40,.05)`; segmented active `0 1px 3px rgba(0,0,0,.12)`; FAB `0 8px 18px rgba(26,36,33,.28)`
- Ergonomic minimums: rows ≥48px, nav ≥52px, buttons ≥34px (secondary) / 44px (primary), calendar blocks ≥44px

## Assets
- Fonts: `app/fonts/schibsted-grotesk-variable.woff2`, `app/fonts/spline-sans-mono-variable.woff2` (already in the repo)
- Icons: inline SVG, 24×24 viewBox, stroke-width 1.8, `stroke=currentColor` style (lucide-like). No raster assets.

## Files
- `More 1a.dc.html` — the full interactive prototype (all 5 surfaces; single-file: template + logic class). The `renderVals()`/state code documents the exact behavior rules.
- `Assessment Report.dc.html` — assessment canvas: ranked findings (1r), faithful baseline (1x), alternative directions (1a–1c, 2a–2d) with rationale.
- `loop/backlog-inbox.md` — task ledger TSK-001..013 with researcher notes (why each change was made)
- `loop/squad-handshake-*.md` — QA acceptance results (tap-target audit, brand-CI audit)

## Open items (not designed — keep production as-is or design later)
- Clients tab, Calendar month view (prototype stubs/toasts)
- Job modal date/client/sessions/notes fields are visual-only in the prototype; wire to real data
- Renewal card currently hardcodes "8-session package · ฿12,000" — derive from the completed package's service/price

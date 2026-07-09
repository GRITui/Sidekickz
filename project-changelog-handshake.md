# Project Changelog Handshake

## System Metadata
- Target Goal: **Freelanz** — a local-first freelance automation PWA (invoicing, tax, doc-gen, booking, CRM, portfolio) for independent workers, English-only MVP, bilingual (EN/TH) on the roadmap.
- Architecture: local-first PWA — vanilla JS single `app.js`, IndexedDB, Service Worker, no backend, no secrets. Borrows proven scaffolding from DriverLog (`../Driver Log/site/`).
- Identity: teal `#0F766E`/`#14B8A6` + marigold `#F59E0B` accent, warm surface `#FBFAF7`, dark theme.
- Orchestration mode: **ultracode** for (a) how agents run, (b) adversarial verification, (c) dynamic skill/tool loading.
- Status: **M2 COMPLETE (verified in-browser)** · v0.3.0 · next: M3 — Booking & CRM
- Last Sync Timestamp: 2026-07-09T10:00:00+07:00
- Local dev server: `cd app && python3 -m http.server 8823` → http://localhost:8823/ (SW/IndexedDB need http, not file://)
- IndexedDB name: `freelanz-v2` (renamed from freelanz-v1 during M1.5 verify; no prior real users).

## Milestones
- [x] **M1 — Foundation**: PWA shell, auth+guest (PBKDF2), IndexedDB, persona onboarding, i18n `t(key@persona)` relabel layer, theming, dashboard, log-job + settings + CSV/JSON export. **DONE + verified.**
- [x] **M1.5 — Refinements**: light-mode-only (toggle removed), job-type dropdown + Custom + Personal gym trainer, Customers module (details), Services catalog w/ rates + fee-prefill. **DONE + browser-verified.**
- [x] **M2 — Money & docs**: invoicing + PromptPay QR, WHT/VAT tax engine, doc-gen templates. **DONE + browser-verified.**
- [ ] **M-AI (backend, later)**: Vercel serverless proxy holding the AI Gateway key (env var) for an AI feature — scope TBD. Key must NEVER be client-side. User's pasted key was exposed in chat → rotate before use.
- [ ] **M3 — Booking & CRM**: day view + travel buffers, follow-up queue, portfolio.
- [ ] **M4 — Polish**: offline hardening, CSV/JSON export, deploy prep (Hostinger, version lockstep, no-cache discipline).

## Reuse Ledger (borrowed from sibling projects)
| System | Source | Disposition |
|---|---|---|
| IndexedDB layer (`openDB/dbAll/dbPut/dbAdd/dbDel/dbGet`) | DriverLog `site/app.js` | lift + add `clients/invoices/documents` stores |
| Auth + guest (`sha256hex/randomSalt/hashPassword/loginGuest/submitAuth/logout`) | DriverLog | lift verbatim |
| i18n engine `t(key@type)` + `applyLang` | DriverLog | lift engine, re-author dict (EN only, 5 personas) |
| Persona onboarding + presets | DriverLog `applyWorkerType` | adapt to 5-persona taxonomy |
| CSV(BOM, injection-safe) + JSON backup/restore | DriverLog | lift verbatim |
| PWA shell / `sw.js` / manifest / subpath build | DriverLog `site/` | lift + rebrand |
| Deploy discipline (version lockstep, no-cache, versioned URLs, Hostinger MCP) | global CLAUDE.md + memory | apply as process |

**NOT borrowed** (handoff §10 + secrets rule): DriverLog brand/red, AdSense id, AccessTrade affiliate slider, `drivee-orchestrator`, PocketBase sync, any tokens/FTP creds.

## Model / Effort policy (approved 2026-07-08, effective M2 onward)
Right-size per task — Opus on the crux, cheaper tiers on mechanical checks:
| Task kind | Model · Effort |
|---|---|
| Builder (multi-file / migration / new screens) | **Opus · high** |
| Verify — data-loss / DB-migration risk | **Opus · high** |
| Fix — applies edits to shared/crux code | **Opus · high** |
| Verify — i18n / UX / handler-exists (logic trace) | **Sonnet · high** |
| Verify — version-lockstep / grep-mechanical | **Haiku · medium** |
_M1.5 ran pre-policy (all Opus·high). Apply this matrix in the M2 workflow via `agent(..., {model, effort})`._

## Delta Change Logs
- 2026-07-08 · orchestrator · INIT · Handshake created. Wireframes (M0) approved as-is. Scope locked: local-first PWA MVP, English-only. Launching M1 build via ultracode workflow (build → 5-lens adversarial verify → fix).
- 2026-07-08 · ultracode-wf `wf_2c61b339-ade` · BUILD · 7 files written to app/ (index.html, login.html, app.js, styles.css, sw.js, manifest.json, icons/icon.svg). DriverLog spine lifted (IDB/auth/i18n/CSV+JSON export/boot); stripped brand/AdSense/affiliate/PocketBase-sync/driver-fields/secrets. node --check + stubbed-DOM runtime tests 21/21 pass. APP_VERSION 0.1.0 / SW freelanz-v0.1.0.
- 2026-07-08 · verify-panel (5 lenses) · VERIFY · 11 findings, 0 high/critical. Auto-fixer applied none (gated to high/critical).
- 2026-07-08 · orchestrator + fix-agent · FIX · Curated 9 fixes applied: importBackup atomicity (data-loss), SHA-256→PBKDF2(100k)+min-pw-8, visible focus rings, form `for`/labels, auto-theme dark contrast (module-pill + settings-input), SW no longer caches 4xx/5xx, delete_job@persona variants, restore no longer bleeds theme/lang. Deferred (2): guest-persistence (intentional per handoff), iOS PNG apple-touch-icon → M4. node --check green.
- 2026-07-08 · orchestrator · LIVE-CHECK · Drove real Chrome @ localhost:8823: guest → onboarding → Photographer persona relabel (live) → log shoot (Net ฿10,000 computed) → dashboard stats update → Shoots list row → full-reload persistence. 0 console errors. M1 signed off.
- 2026-07-08 · ultracode-wf `wf_973fe4b7-91c` · M1.5 BUILD+VERIFY+FIX · 5 files edited in place; DB_VER 1→2 adds `services` store (guarded, no data loss). Verify (4 lenses): 3 findings, 1 high (customer-intake data-loss) auto-fixed. Model/effort: all Opus·high (ran pre-policy).
- 2026-07-08 · orchestrator · M1.5 FIXES · Applied 2 remaining verify lows (job-type-preserve-on-edit; pre-paint light inline script) + 2 self-found robustness fixes during live check: `openDB` `onblocked`/`onversionchange` (multi-tab upgrade could wedge — real), boot() error-surface instead of silent blank. Bumped v0.2.0→0.2.1 (lockstep). Renamed DB freelanz-v1→v2 (v1 got wedged locally by aggressive debug delete-while-open).
- 2026-07-08 · orchestrator · M1.5 LIVE-CHECK · Clean Chrome run: fresh boot→login→**light mode** (no toggle) → guest → job-type **dropdown** → gym persona relabel (Sessions/Member) → **services seeded** (gym-only, correct) → add-session **service prefills fee ฿800** → **saves + persists**, dashboard ฿800/1. 0 console errors. Note: two transient anomalies during debugging were self-inflicted test-state pollution, disproven by clean run. M1.5 signed off.
- 2026-07-08 · orchestrator · DIRECTION · User adopted ultracode for agents/verify/dynamic-skills; approved per-task model/effort matrix (see above). Vercel = later serverless-proxy AI feature (backend). Next: secrets .gitignore → git init → GitHub via gh.
- 2026-07-09 · ultracode-wf · M2 BUILD+VERIFY+FIX (commit `f082abc`) · Parallel module fan-out over a shared scaffold contract: tax.js (WHT/VAT `computeTax`, TH-convention math) ∥ invoices.js (quote→invoice, line items w/ service prefill, deposit, statuses, auto-numbered `INV-YYYY-####` per-uid, detail/print view) ∥ docgen.js (Contract/NDA/Quote from customer intake, print/export). PromptPay: self-contained EMVCo payload + CRC16-CCITT + QR encoder, fully offline. Adversarial verify found + fixed: PromptPay 0066-mobile misclassification, a11y (labels/focus/keyboard), print-CSS scoping, version-lockstep. `invoices`/`documents` IndexedDB stores added (guarded `contains()` checks; `DB_VER` stayed at 2 — see backlog). Light-mode only, no backend, no secrets. Bumped v0.2.1→0.3.0 (lockstep across app.js/sw.js/index.html/login.html).
- 2026-07-09 · orchestrator · LIVE-CHECK · Drove real Chromium @ localhost:8823: guest → onboarding → set PromptPay ID → add customer (Acme Co) → add service (Consulting ฿5,000/hour, gym-seed defaults intact) → new invoice, picked client + line item (2×฿2,500) → correct VAT(7%)/WHT(3%) breakdown → saved as **INV-2026-0001** → detail view renders a scannable PromptPay QR canvas → Tax screen breakdown computes live → Docs screen → New Contract form opens pre-filled with customer/date. 0 console errors across the full flow. M2 signed off.

## Known polish backlog (non-blocking, from live check + verify)
- Shoots/jobs list row shows client name twice (title + subtitle) when jobType is empty — use jobType or "Shoot" as title. (low)
- iOS needs a raster (PNG) apple-touch-icon + 192/512 manifest PNGs → bundle with M4 icon set. (low)
- Guest data persists on shared device by design; consider an explicit "start fresh" vs "resume" prompt later. (low)
- `DB_VER` stayed at 2 when M2 added `invoices`/`documents` stores (guarded by `contains()`, not a version bump) — `onupgradeneeded` only fires on version increase, so an *existing* v2 database (from an M1.5 install) won't get the new stores. Harmless today (no real users yet, fresh installs create all stores in one pass), but bump `DB_VER` to 3 before any real deploy/M4. (low, pre-launch)

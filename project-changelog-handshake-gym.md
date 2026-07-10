# Project Changelog Handshake — Personal Gym Trainer (squad: gym)

## System Metadata
- Target Goal: **Freelanz Gym** — a dedicated, single-purpose fork of Freelanz for solo personal trainers. Forked from the general multi-persona Freelanz app; the persona picker and all non-gym persona code have been removed.
- Squad / trunk branch: `personal-gym-trainer-freelanz` (this squad's own trunk, separate from the general app's `main`). Feature work happens on topic branches off this trunk (e.g. `gym/member-tags`), landed via PR — never pushed to the trunk directly.
- Fork point: `c955d3c` (general Freelanz app, "Add Quote → Invoice conversion"). Everything the general app has added since that commit (Pipeline/Kanban board, SVG line-icons, `/info` how-to page, AI-draft gating flag) is **not** in this squad unless explicitly backported — see Feature Drift below.
- Co-hosting: this app is deployed to the same GitHub Pages site as the general app, at `/gym/` instead of `/`. Both are built from a single combined workflow (`.github/workflows/deploy-pages.yml`, kept in sync across both squads' trunks) that checks out both branches on every run so a push to either can never wipe out the other's live pages.
- Storage isolation: because both apps share one origin, this app's IndexedDB/localStorage/sessionStorage/Cache Storage keys are all namespaced (`freelanz-gym-v1` DB, `gym_`-prefixed storage keys, `freelanz-gym-shell-*` cache) so the two apps' local data can never collide. `DB_VER` currently **5** (`memberTags` store added).
- Identity: same teal/marigold palette as the general app; app name is "Freelanz Gym" (title/manifest/sidebar) so two installed PWAs don't look identical on a home screen.
- Live URL: `https://gritui.github.io/FreeLanz/gym/` (requires the `github-pages` environment's deployment-branch policy to allow this branch — a one-time manual repo-settings step, already done).
- Last Sync Timestamp: 2026-07-10

## Execution Mode Policy (applies repo-wide, both squads — set 2026-07-10)
- **Autonomous, PR-only.** Work proceeds without stopping to ask permission for each step, but git changes only ever land as an **opened pull request** — never a direct push to a trunk branch (`main` for the general-app squad, `personal-gym-trainer-freelanz` for this squad).
- **User merges.** PRs are never self-merged going forward; the user reviews and merges themselves. (A prior one-off self-merge of PR #4 predates this policy and was done under explicit one-time authorization — not a standing pattern.)
- **Handshake files: one per squad.** This file tracks the gym squad only; the general app's `project-changelog-handshake.md` tracks that squad only. Don't cross-pollinate state between them.
- Open precision question flagged back to the user: "no push" is being read as *no push to a protected trunk branch* — pushing a topic/feature branch (required to open any PR at all) is assumed still fine. Flagging this reading explicitly in case it's not what was intended.

## Milestones
- [x] **Persona strip** — removed the onboarding/Settings work-type picker, `PERSONAS`/`UNIT_WORD`/custom-work-type escape hatch, and all non-gym `CUSTOMER_INTAKE`/`SEED_SERVICES`/i18n entries; consolidated the `@gym` i18n suffix keys into base keys since only one persona now exists. Boot auto-sets `workType='gym'`. **DONE + browser-verified** (commit `848c4e8`).
- [x] **Ship as a separate live app** — combined-build Pages workflow (`/` = general app, `/gym/` = this squad), storage-namespace isolation (DB/localStorage/sessionStorage/cache), distinct app identity (title/manifest/branding). **DONE + live-verified** — deploy ran green end-to-end on GitHub Actions. (commit `fee0028`)
- [x] **Comparison/regression testing before next version** — full local regression of this app (18/18 checks, 0 console errors) across sessions/customers/services/invoices/tax/bookings/followups/portfolio/research/backup-roundtrip, plus a smoke-test comparison against the general app to catalog feature drift since the fork point. **DONE.**
- [~] **Member tags** (in progress, branch `gym/member-tags`) — the session form's free-text "Member" field now auto-saves each new name as a reusable, id-backed tag (datalist autocomplete on the form; new `memberTags` IndexedDB store, `DB_VER` 4→5). A dedicated Settings ▸ Member tags screen lists tags with session counts, supports manual add, **rename with propagation** (renaming a tag rewrites every past session's `client` text — the reason tags have an id instead of being a plain string), and delete (unlinks `memberTagId` from past sessions without touching their stored member name). Feature-tested locally: 8/9 automated checks pass (the 1 "failure" was a wrong assumption in the test script itself — job list rows show the *service* name as the title and the member name as the subtitle, not the other way around — not a product bug). Pending: PR into `personal-gym-trainer-freelanz` for user review/merge.

## Feature Drift vs. the general app (since fork point `c955d3c`)
Not yet decided whether to backport any of these — flagging for a future call:
| General app has (since fork) | This squad has it? |
|---|---|
| Pipeline / Kanban engagement board (Service → Invoice → Paid) | No |
| `/info/` how-to page linked from login | No |
| Emoji-free SVG line-icons throughout | No — still emoji icons from the fork point |
| AI Draft button gated behind `window.FREELANZ_AI` | No — untouched from fork point (M-AI remains globally paused per the general app's handshake anyway) |

## Backlog (self-researched, not yet built)
- Session package tracking (N-session bundles, e.g. "buy 10, track remaining")
- Client progress log (weight/measurements over time)
- Quick session check-in (one-tap log for a recurring client)
- Tag **merge** (combine two tags representing the same person, e.g. "Alex" + "Alex Chan") and **promote tag → full Customer profile** — scoped out of the first Member Tags cut to keep it shippable; noted here rather than silently dropped.

## Delta Change Log
- 2026-07-10 · orchestrator · Forked `personal-gym-trainer-freelanz` from the general app at `c955d3c` per user request ("Fork this to another branch. 'Personal Gym Trainer FreeLanz'").
- 2026-07-10 · orchestrator · BUILD — stripped multi-persona code, hardcoded `workType='gym'`, consolidated i18n. Live-verified. Commit `848c4e8`.
- 2026-07-10 · orchestrator · BUILD — shipped as a separate live app at `/gym/` on the shared GitHub Pages site: combined-build workflow, storage-namespace isolation (real bug caught and fixed before shipping — origin-scoped storage would have silently shared data with the general app), distinct branding. Commit `fee0028`. Required one manual step (widening the `github-pages` environment's branch policy) that the user completed. Companion PR #7 opened against `main` so a future push to `main` doesn't wipe out `/gym/`.
- 2026-07-10 · orchestrator · ASSESS — full regression test of the gym app (18/18 pass, 0 errors) + smoke-test comparison against the general app, cataloging feature drift since the fork point. No code shipped this pass, per user direction to stay in research/assess.
- 2026-07-10 · orchestrator · BUILD (in progress, branch `gym/member-tags`) — Member tags feature: auto-save-as-tag, autocomplete, rename-with-propagation, delete-unlinks-only, Settings management screen, `memberTags` added to the JSON backup/restore set. `DB_VER` 4→5. Feature-tested (8/9 automated checks pass; the 1 fail was a test-script assumption error, not a product bug).
- 2026-07-10 · orchestrator · POLICY — recorded the repo-wide "autonomous, PR-only, user-merges, one-handshake-file-per-squad" execution mode per user instruction (screenshot). Flagged one precision question back to the user (scope of "no push").

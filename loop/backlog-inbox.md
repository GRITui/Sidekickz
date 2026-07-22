# Backlog Inbox — Sidekick design refinement loop
Append-only ledger. Owner idea logged by Owner-Assistant-Agent 2026-07-22; triaged by Researcher-Squad same cycle.

<task_item>
  <id>TSK-001</id>
  <source>OWNER_POPUP</source>
  <status>READY_FOR_PM</status>
  <priority>HIGH</priority>
  <title>Assess all functional designs; rank refinement candidates</title>
  <description>Assess Sidekick's functional screens for user friction / UX debt, mobile ergonomics (44px+ targets, one-hand reach), and feature discoverability. All personas weighted equally. Keep brand CI (Schibsted Grotesk / Spline Sans Mono, --brand #22554B, --marigold #C08A3E, warm paper surfaces, radius 16/11, bottom-sheet modals).</description>
  <researcher_notes>Codebase read: app/index.html, styles.css, nav structure, module files list. 11 functional surfaces identified. Ranked below in TSK-002..006 by combined friction x ergonomics x discoverability score.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-002</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status>
  <priority>HIGH</priority>
  <title>Candidate #1 — More/Settings screen: discoverability sink</title>
  <description>s-more hosts 12 collapsible sections mixing daily tools (Follow-ups, Portfolio, Research, Insights, Invoices, Docs) with one-time setup (LINE, Shop, Team, Tax defaults, Business info). Nav badge on "More" signals hidden actionable items. Three whole product modules are only reachable via More ▸ More tools — maximal discoverability failure. Long scroll, no search.</description>
  <researcher_notes>Score 9/10. Directly hits 2 of 3 owner criteria (discoverability + friction). Every persona passes through here. RECOMMENDED TOP CANDIDATE.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-003</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status>
  <priority>HIGH</priority>
  <title>Candidate #2 — Job modal: overloaded bottom sheet</title>
  <description>modal-job stacks date, client, fast-path, service, package, 4 numeric fields, notes, net box, options compared, items, plan & payments (sub-tasks + milestones + dated steps), time tracking, then 3 stacked buttons (Save / Delete / Cancel as btn-danger styling). ~2.5 screens of scroll inside a 92vh sheet.</description>
  <researcher_notes>Score 8/10. Highest-frequency interaction in the app (FAB target). Friction-heavy; danger-styled Cancel is an ergonomics/affordance bug.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-004</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status>
  <priority>MEDIUM</priority>
  <title>Candidate #3 — Home: alert/attention duplication</title>
  <description>Home shows hero, quick actions, goal card, home-alert-card, attn-card ("Needs attention"), and "Up next" — three separate urgency surfaces with different visual grammars competing on one screen.</description>
  <researcher_notes>Score 6/10. Friction moderate; well within brand. Refine after TSK-002/003.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-005</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status>
  <priority>MEDIUM</priority>
  <title>Candidate #4 — Week view calendar: dense touch grid</title>
  <description>wk-daycol 76px columns, 60px hour cells, 9-11px type; blocks below 44px height are common. Off-range ▲▼ hints tiny.</description>
  <researcher_notes>Score 5/10. Ergonomics issue but usage is lower-frequency than pipeline/invoices; desktop grid mitigates.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-006</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status>
  <priority>LOW</priority>
  <title>Candidate #5 — Task flow chip rail + minimap</title>
  <description>Stage chips + marigold minimap + hint text is a novel 3-layer navigation for 6 stages; new users must learn it. Cards themselves are solid.</description>
  <researcher_notes>Score 4/10. Recently redesigned (kb-* cards); refinement risk of churn. Keep.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-007</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status><!-- Owner-approved 2026-07-22, see TSK-015 -->
  <priority>HIGH</priority>
  <title>UX-UI-Designer: produce 3 mockup directions for top candidate (TSK-002, More/Settings)</title>
  <description>Design 2-3 refinement directions for the More/Settings surface. Hard constraint: same look&feel and brand CI — reuse existing tokens, type, radii, list-card/settings-row patterns. No new colors.</description>
  <researcher_notes>Handoff to UX-UI-Designer-Squad this epoch.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-008</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status><!-- built interactive in More 1a.dc.html; QA PASS epoch 7; Owner-approved 2026-07-22, see TSK-015 -->
  <priority>HIGH</priority>
  <title>Job modal refinement direction (candidate #2)</title>
  <description>Split the 2.5-screen sheet into a Quick log / Full details segmented sheet: quick path = date, client, fee, net, save; advanced sections (plan & payments, items, time tracking) collapse to drill rows with counts. Cancel de-escalated from danger styling to plain text. Direction 2a delivered.</description>
  <researcher_notes>UX-UI-Designer epoch 3. Owner review via report canvas #2a.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-009</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status><!-- built interactive in More 1a.dc.html Home tab; QA PASS epoch 7; Owner-approved 2026-07-22, see TSK-015 -->
  <priority>MEDIUM</priority>
  <title>Home urgency-surface merge (candidate #3)</title>
  <description>Merge home-alert-card + attn-card + incoming pipeline into one "Today" stack using the existing list-row grammar and chip colors; hero and goal card untouched. Direction 2b delivered.</description>
  <researcher_notes>UX-UI-Designer epoch 4. Owner review via report canvas #2b.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-010</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status><!-- built interactive: Calendar tab in More 1a.dc.html (3-day pager, 72px rows, 62px blocks); epoch 8; Owner-approved 2026-07-22, see TSK-015 -->
  <priority>MEDIUM</priority>
  <title>Calendar week view ergonomics (candidate #4)</title>
  <description>Default mobile zoom to 3-day columns (~118px), hour rows 72px, blocks min 44px with 12px+ type; 7-day stays for >=900px. Day pager reuses cal-navbtn tokens. Direction 2c delivered.</description>
  <researcher_notes>UX-UI-Designer epoch 5. Owner review via report canvas #2c.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-011</id>
  <source>RESEARCHER_SQUAD</source>
  <status>READY_FOR_PM</status><!-- built interactive: Task flow tab in More 1a.dc.html (chip underlines replace minimap, cards move stages); epoch 8; Owner-approved 2026-07-22, see TSK-015 -->
  <priority>LOW</priority>
  <title>Task flow rail light-touch (candidate #5)</title>
  <description>Keep the recent kb-* redesign. Light touch only: fold the marigold minimap into the chips as a progress underline, drop the always-on hint sentence to first-run only. Direction 2d delivered.</description>
  <researcher_notes>UX-UI-Designer epoch 6. Owner review via report canvas #2d.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-012</id>
  <source>OWNER_POPUP</source>
  <status>READY_FOR_PM</status><!-- Owner-approved 2026-07-22, see TSK-015 -->
  <priority>HIGH</priority>
  <title>Task flow: 4 client paths + incident notes + stage-gate booking</title>
  <description>Cards gained Cancel (red, tweakable to quiet "Lost"), Redo (attempt counter), Postpone (tap deadline chip), and Advance. Advancing opens an inline stage-gate to book the next deadline (Skip allowed); skipped stages show an amber "No date booked" banner that reopens the gate. Cancel/Redo/Postpone capture an optional quick note, shown on the card as italic quote.</description>
  <researcher_notes>Built in More 1a.dc.html epochs 9-10. Quote advance relabeled "Client accepted" per owner question about "Mark booked" ambiguity.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-013</id>
  <source>OWNER_POPUP</source>
  <status>READY_FOR_PM</status><!-- Owner-approved 2026-07-22, see TSK-015 -->
  <priority>HIGH</priority>
  <title>Task flow: multi-session package delivery + renewal loop</title>
  <description>Deliver-stage cards with pkg{used,total} show a session progress bar and "Log session N of M" action; each log opens a gate to book the NEXT session (skip = amber banner). Final session's gate offers "Send renewal quote" which completes the card and spawns a renewal card in Quote with the follow-up date, closing the renewal loop before a gap.</description>
  <researcher_notes>Demo cards: Ploy 1/8 (session flow), Mek 7/8 (renewal flow). Built epoch 11.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-014</id>
  <source>OWNER_POPUP</source>
  <status>READY_FOR_PM</status><!-- SHIPPED by Engineer-Squad 2026-07-22: commit 8add6cf, PR #64 (open). Full regression 703/703 Playwright + 73/73 Node. See squad-handshake-engineer.md. -->
  <priority>HIGH</priority>
  <title>Stage-model migration: 6 stages -> 4 (Inquiry/Quote/Booked/Deliver)</title>
  <description>Owner confirmed a REAL migration, not a visual relabel: collapse the production STAGES ['pitch','quote','invoice','paid','delivery','extend'] to ['inquiry','quote','booked','deliver']. Invoice+Paid collapse into Booked (a job in Booked can still have zero/one/many linked invoices and a paid/unpaid state tracked as a job-level flag, not a stage); Delivery+Extend collapse into Deliver (package renewal becomes an explicit action — "Send renewal quote" — that spawns a new card in Quote, rather than a stage the job sits in). Must preserve: jobEarned()-driven revenue reporting (Home hero, goal card, Team billing, tax roll-up all read this), package delivery counting (jobDelivered()), invoice/payment linkage (onInvoiceMarkedPaid reverse hook), docgen quote/invoice generation, followups queue, booking links, dated sub-tasks/appointment gate. Existing installs' stored job.stage values ('pitch'/'invoice'/'paid'/'extend') need a one-time migration to the new 4-stage vocabulary on load, not a hard break. Blast radius (grep-confirmed): app.js, bookings.js, docgen.js, followups.js, invoices.js, tax.js, sql schema, api FIELDS, dataClient mirror, 12+ existing test suites, demo data for all 7 personas, i18n (EN+TH).</description>
  <researcher_notes>Foundational — TSK-011/012/013 (Task flow UI) sit on top of this and cannot be meaningfully verified until it lands. Sequenced first in the PM build order.</researcher_notes>
</task_item>

<task_item>
  <id>TSK-015</id>
  <source>OWNER_POPUP</source>
  <status>READY_FOR_PM</status>
  <priority>HIGH</priority>
  <title>Owner decision: adopt the full design_handoff_sidekick_refinements bundle</title>
  <description>Owner (Krit) reviewed the bundle (README.md, More 1a.dc.html interactive prototype, Assessment Report.dc.html, this ledger) and approved all five refined surfaces (TSK-002/007 More-Settings, TSK-008 Job modal, TSK-009 Home Today, TSK-010/011 Calendar + Task-flow light-touch, TSK-012/013 Task-flow client-paths + package renewal) for implementation into the production Sidekickz codebase (app/ vanilla JS + styles.css, no framework). Explicitly chose the harder of two options on the one open architectural question raised during triage: migrate the pipeline to the prototype's real 4-stage model (TSK-014) rather than keep 6 stages with a relabeled chip rail. Build order: TSK-014 (stage migration, foundational) -> TSK-012/013/011 (Task flow) -> TSK-002/007 (More/Settings) -> TSK-009 (Home) -> TSK-008 (Job modal) -> TSK-010 (Calendar). Each surface ships as its own tested, reviewed pass (assess -> build -> verify -> full regression), matching this repo's own established changelog convention, not one giant commit.</description>
  <researcher_notes>Design assets copied into loop/design-handoff/ for implementer reference. Prototype markup uses literal pixel/hex values throughout (README confirms these trace to real styles.css tokens) -- map back to var(--*) when implementing, do not hardcode.</researcher_notes>
</task_item>

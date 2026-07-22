<squad_metadata>
  <squad_name>Engineer-Squad</squad_name>
  <current_status>IDLE</current_status>
  <active_task_id>none</active_task_id>
  <sprint_completion_percentage>100</sprint_completion_percentage>
</squad_metadata>

## Current Focus
`design_handoff_sidekick_refinements` batch COMPLETE. All 6 backlog items
(TSK-014, TSK-012/013/011, TSK-002/007, TSK-009, TSK-008, TSK-010) shipped
across 5 epochs. TSK-014 merged separately (PR #64); the remaining 5 are
one continuously-extended PR #65, since all landed on the same designated
session branch. Squad goes IDLE pending owner review/merge of PR #65 and
the one open decision below — no more READY_FOR_PM items remain in this
batch for this squad to pull.

Build reliability across the 5 epochs: epoch 1 (TSK-014) needed inline
recovery from a build-agent stall; epochs 2-5 (TSK-012/013/011,
TSK-002/007, TSK-009, TSK-008, TSK-010) all committed and pushed cleanly
on their own. Every epoch's build was independently re-verified against a
freshly re-run regression battery and, where relevant, the raw diff itself
— not taken on the build agent's self-report.

## Recent Commits / PRs
* PR #64 (merged): TSK-014 stage migration (6→4 stages) + LINE Login deferral.
* PR #65 (open) — full batch, cumulative regression tally by the time the
  last task landed: **Playwright 840/840 across 33 suites**, Node 73/73
  across the 6 runnable harnesses (9 pre-existing, unrelated crashes,
  consistent throughout every entry in this file).
  - TSK-012/013/011 Task-flow rebuild (737/737 at ship time)
  - TSK-002/007 More/Settings restructure (741/741 at ship time)
  - TSK-009 Home "Today" merge (780/780 at ship time)
  - TSK-008 Job modal Quick log / Full details split (816/816 at ship time)
  - TSK-010 Calendar 3-day mobile view (840/840 at ship time, final)

## Blockers & QA Failures
(none — no task hit the 3-strike breaker across the whole batch)

## Cross-Squad Requests
* Owner: PR #65 has one open decision, unresolved across the whole batch —
  the new inline stage-gate (TSK-012) writes `job.due` as a scalar reminder
  and no longer creates a real calendar booking (`createBookingForStep()`),
  per the design handoff's literal `due: ISO|null` spec. The OLD gate, at
  least for Inquiry-stage exact dates, DID create a real `bookings` row
  visible on Calendar/Week view. Gate copy ("Book the follow-up") still
  reads as if it books a slot. TSK-010's verify pass confirmed this is
  still the only loose end in the whole batch — Calendar itself works
  correctly, it just never receives a booking from this specific path.
  Needs an explicit call: keep as reminder-only (reword the gate copy), or
  wire `createBookingForStep()` back in for exact-date gates.
* Owner (lower priority, noted not urgent): the old `markJobLost()` fixed-
  reason chip picker is now unreachable from any UI button (Cancel's
  free-text `job.note` replaced it in practice) but is still fully defined
  and tested. Two "why lost" mechanisms coexist, one orphaned.
* Owner (lower priority, noted not urgent): TSK-002's rebuild dropped
  Manage's Invoices/Docs rows from More entirely — verified as a legitimate
  no-op (Home's quick-action row already reaches both, predates this task).

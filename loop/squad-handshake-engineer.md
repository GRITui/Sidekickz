<squad_metadata>
  <squad_name>Engineer-Squad</squad_name>
  <current_status>EXECUTING</current_status>
  <active_task_id>TSK-010</active_task_id>
  <sprint_completion_percentage>100</sprint_completion_percentage>
</squad_metadata>

## Current Focus
Epoch 4 closed: TSK-008 (Job modal Quick/Full split) shipped, folded into
PR #65. Epoch 5 (final of this batch) now pulls TSK-010 (Calendar 3-day
mobile view) — the last item in the owner's recorded build order (TSK-015).
Once this lands, all 5 refined surfaces from the design handoff are built.

Epoch 4's build finished clean (committed + pushed on its own, no stall) —
third clean finish in a row after epoch 1's stall. Verify independently
drove all 4 job-modal sub-features (options/items/plan&payments/time
tracking) through the real UI end-to-end, not just re-read the build's
own test suite.

## Recent Commits / PRs
* PR #64 (merged): TSK-014 stage migration (6→4 stages) + LINE Login deferral.
* PR #65 (open, now covers four tasks, all on the same designated branch):
  - TSK-012/013/011 Task-flow rebuild. Playwright 737/737. Bonus fix:
    job.paid not preserved on edit (uncredited TSK-014 bug).
  - TSK-002/007 More/Settings restructure. Playwright 741/741. Zero lost
    actions (independently audited).
  - TSK-009 Home "Today" merge. Playwright 780/780. All 7 row types
    preserved, hero/goal untouched, one new capability (next-booking-today).
  - TSK-008 Job modal Quick log / Full details split. Playwright 816/816.
    All 4 sub-features (options/items/plan&payments/time-tracking) confirmed
    still fully functional behind new collapsed drill rows, not lost.

## Blockers & QA Failures
(none — no task hit the 3-strike breaker, 4/5 tasks shipped clean)

## Cross-Squad Requests
* Owner: PR #65 has one open decision, not resolved in-PR — the new inline
  stage-gate (TSK-012) writes `job.due` as a scalar reminder and no longer
  creates a real calendar booking (`createBookingForStep()`), per the design
  handoff's literal `due: ISO|null` spec. The OLD gate, at least for
  Inquiry-stage exact dates, DID create a real `bookings` row visible on
  Calendar/Week view. Gate copy ("Book the follow-up") still reads as if it
  books a slot. Needs an explicit call before/at merge: keep as reminder-only
  (reword the gate copy), or wire `createBookingForStep()` back in.
* Owner (lower priority, noted not urgent): the old `markJobLost()` fixed-
  reason chip picker is now unreachable from any UI button (Cancel's
  free-text `job.note` replaced it in practice) but is still fully defined
  and tested. Two "why lost" mechanisms coexist, one orphaned.
* Owner (lower priority, noted not urgent): TSK-002's rebuild dropped
  Manage's Invoices/Docs rows from More entirely — verified as a legitimate
  no-op (Home's quick-action row already reaches both, predates this task).

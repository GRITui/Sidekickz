<squad_metadata>
  <squad_name>Engineer-Squad</squad_name>
  <current_status>EXECUTING</current_status>
  <active_task_id>TSK-002/TSK-007</active_task_id>
  <sprint_completion_percentage>100</sprint_completion_percentage>
</squad_metadata>

## Current Focus
Epoch 1 closed: TSK-012/013/011 (Task-flow rebuild) shipped as PR #65. Epoch 2
now pulls TSK-002/007 (More/Settings restructure) per the parallel-pickup
rule — not waiting on PR #65's review to start the next item.

Build note for epoch 1, for the record: the build agent stalled mid-run
(returned early saying it would "wait for a background monitor" instead of
finishing) rather than hitting the usual session-limit death — a new failure
mode worth watching for. Real, tested work was sitting uncommitted in the
tree when it stopped; the orchestrator committed it after the verify pass
independently re-confirmed it against a clean baseline.

## Recent Commits / PRs
* PR #64 (merged): TSK-014 stage migration (6→4 stages) + LINE Login deferral.
* PR #65 (open): TSK-012/013/011 Task-flow rebuild — chip rail w/ progress
  underline, note line, attempt badge, deadline chip, pending banner, package
  progress bar, inline 9-variant stage-gate card, package renewal loop.
  Playwright 737/737. Also fixed an uncredited pre-existing bug from TSK-014
  (job.paid wasn't preserved on edit).

## Blockers & QA Failures
(none — no task hit the 3-strike breaker)

## Cross-Squad Requests
* Owner: PR #65 has one open decision, not resolved in-PR — the new inline
  stage-gate writes `job.due` as a scalar reminder and no longer creates a
  real calendar booking (`createBookingForStep()`), per the design handoff's
  literal `due: ISO|null` spec. The OLD gate, at least for Inquiry-stage
  exact dates, DID create a real `bookings` row visible on Calendar/Week
  view — that auto-populate path is gone for pipeline-driven gates (the
  manual job-detail "+ Step with date" flow is untouched). Gate copy ("Book
  the follow-up") still reads as if it books a slot. Needs an explicit call:
  keep as a reminder-only field (and reword the gate copy so it stops
  implying a booking), or wire `createBookingForStep()` back in for exact-
  date gates so Calendar keeps reflecting pipeline activity.
* Owner (lower priority, noted not urgent): the old `markJobLost()` fixed-
  reason chip picker is now unreachable from any UI button (Cancel's
  free-text `job.note` replaced it in practice) but is still fully defined
  and tested. Two "why lost" mechanisms coexist, one orphaned — worth a
  conscious decision on a future pass (retire it, or wire it back in
  alongside the free-text note).

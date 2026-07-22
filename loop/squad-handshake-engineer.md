<squad_metadata>
  <squad_name>Engineer-Squad</squad_name>
  <current_status>EXECUTING</current_status>
  <active_task_id>TSK-008</active_task_id>
  <sprint_completion_percentage>100</sprint_completion_percentage>
</squad_metadata>

## Current Focus
Epoch 3 closed: TSK-009 (Home "Today" merge) shipped, folded into PR #65
(same designated branch). Epoch 4 now pulls TSK-008 (Job modal Quick log /
Full details split) per the owner's recorded build order in TSK-015 — the
last item before TSK-010 (Calendar), which closes out the whole batch.

Epoch 3's build finished clean again (committed + pushed on its own, no
stall) — matches epoch 2, not epoch 1's stall pattern. Verify caught one
immaterial discrepancy (task brief cited a slightly stale baseline number)
and confirmed it reconciled exactly, no real issue.

## Recent Commits / PRs
* PR #64 (merged): TSK-014 stage migration (6→4 stages) + LINE Login deferral.
* PR #65 (open, now covers three tasks since all landed on the same
  designated branch):
  - TSK-012/013/011 Task-flow rebuild. Playwright 737/737. Also fixed an
    uncredited pre-existing bug from TSK-014 (job.paid not preserved on edit).
  - TSK-002/007 More/Settings restructure — 12 sections down to 3 flat
    groups + 4 drill-ins, zero lost actions (independently audited).
    Playwright 741/741 after a badge-fix follow-up commit.
  - TSK-009 Home "Today" merge — 3 old urgency surfaces (home-alert-card,
    attn-card, incoming-pipeline) into one prioritized list-card, all 7 row
    types preserved (independently re-derived from the raw diff), hero/goal
    card byte-identical untouched, plus a genuinely new next-booking-today
    row. Playwright 780/780.

## Blockers & QA Failures
(none — no task hit the 3-strike breaker)

## Cross-Squad Requests
* Owner: PR #65 has one open decision, not resolved in-PR — the new inline
  stage-gate (TSK-012) writes `job.due` as a scalar reminder and no longer
  creates a real calendar booking (`createBookingForStep()`), per the design
  handoff's literal `due: ISO|null` spec. The OLD gate, at least for
  Inquiry-stage exact dates, DID create a real `bookings` row visible on
  Calendar/Week view — that auto-populate path is gone for pipeline-driven
  gates (the manual job-detail "+ Step with date" flow is untouched). Gate
  copy ("Book the follow-up") still reads as if it books a slot. Needs an
  explicit call: keep as a reminder-only field (and reword the gate copy so
  it stops implying a booking), or wire `createBookingForStep()` back in for
  exact-date gates so Calendar keeps reflecting pipeline activity.
* Owner (lower priority, noted not urgent): the old `markJobLost()` fixed-
  reason chip picker is now unreachable from any UI button (Cancel's
  free-text `job.note` replaced it in practice) but is still fully defined
  and tested. Two "why lost" mechanisms coexist, one orphaned.
* Owner (lower priority, noted not urgent): TSK-002's rebuild dropped
  Manage's Invoices/Docs rows from More entirely — verified as a legitimate
  no-op (Home's quick-action row already reaches both, predates this task).

<squad_metadata>
  <squad_name>Engineer-Squad</squad_name>
  <current_status>EXECUTING</current_status>
  <active_task_id>TSK-009</active_task_id>
  <sprint_completion_percentage>100</sprint_completion_percentage>
</squad_metadata>

## Current Focus
Epoch 2 closed: TSK-002/007 (More/Settings restructure) shipped, folded into
PR #65 (same designated branch, so it's an expanded PR rather than a new
one). Epoch 3 now pulls TSK-009 (Home "Today" stack merge) per the parallel-
pickup rule and the owner's recorded build order in TSK-015.

Epoch 2's build finished clean (committed + pushed on its own, no stall) —
unlike epoch 1. Independent verification caught one real cosmetic bug (the
Follow-ups tool-badge never actually hid at zero due, a CSS specificity
issue) that the build's own new test suite didn't catch because it only
asserted the DOM `hidden` property, not actual computed rendering — fixed
in a follow-up commit, confirmed live before shipping.

## Recent Commits / PRs
* PR #64 (merged): TSK-014 stage migration (6→4 stages) + LINE Login deferral.
* PR #65 (open, now covers two tasks since both landed on the same
  designated branch):
  - TSK-012/013/011 Task-flow rebuild — chip rail w/ progress underline,
    note line, attempt badge, deadline chip, pending banner, package
    progress bar, inline 9-variant stage-gate card, package renewal loop.
    Playwright 737/737. Also fixed an uncredited pre-existing bug from
    TSK-014 (job.paid wasn't preserved on edit).
  - TSK-002/007 More/Settings restructure — 12 collapsible sections down to
    3 flat groups + 4 drill-in sub-pages, everything ≤1 tap deeper. Every
    reachable action independently traced to a new home (zero losses).
    Playwright 741/741 after the badge-fix follow-up commit.

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
  and tested. Two "why lost" mechanisms coexist, one orphaned — worth a
  conscious decision on a future pass (retire it, or wire it back in
  alongside the free-text note).
* Owner (lower priority, noted not urgent): TSK-002's rebuild dropped
  Manage's Invoices/Docs rows from More entirely — verified as a legitimate
  no-op (Home's quick-action row already reaches both screens, predates this
  task), not a loss, but worth knowing About/More is slightly thinner now if
  that redundancy was ever relied on.

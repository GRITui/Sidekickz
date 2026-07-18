# Sidekickz → Grit BizSuite monorepo

As of this branch, Sidekickz's codebase (snapshot of `22e6df0`, this repo's
`main`) has been merged into the **Grit BizSuite monorepo** as
**`apps/grit-taskboard`**.

- Monorepo home: `GRITui/horeca-pos`, branch
  `claude/grit-bizsuite-monorepo-spec-0ol8qo` (repo restructured into a
  turbo/npm-workspaces monorepo per the Grit BizSuite blueprint spec).
- Grit Taskboard pivot delivered there: an operations kanban board
  (`todo / in_progress / review / done`) layered onto the existing PWA, with
  event-driven card automation — `inventory.threshold_breached` creates
  "Restock SKU …" cards and `pos.velocity_surge` creates high-priority
  "Open auxiliary billing terminal" cards, received as HMAC-signed internal
  webhooks (`packages/shared-events`, mirrored in plain JS in
  `apps/grit-taskboard/lib/gritEvents.js`).

## What this means for this repo

New Grit Taskboard work should land in the monorepo, not here. This repo
remains the standalone Sidekick freelancer-PWA history (the freelancer pipeline
features are untouched by the pivot). If the monorepo direction is reverted,
`apps/grit-taskboard` can be extracted back — it keeps its own `package.json`,
`vercel.json`, and no-build structure, and still runs standalone.

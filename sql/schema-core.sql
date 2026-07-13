-- Sidekick — core app schema (Phase 1 of the local-first -> backend migration)
--
-- Sibling to schema.sql, not a merge into it: schema.sql is the LINE
-- self-service booking pilot's own schema, explicitly single-tenant by
-- design (see its own header comment) — its `services`/`bookings` table
-- names and shapes are unrelated to and would collide with the general,
-- multi-tenant tables this file defines for the app's own core data.
--
-- `cuid` is the real primary key throughout, matching the client-generated
-- UUID (`cuid()` in app/app.js) every record already carries today. The
-- client keeps minting its own id exactly as it does now; the server only
-- validates and inserts. That is what makes the one-time local->server
-- upload (api/migrate-upload.js) idempotent via `on conflict (cuid) do
-- nothing`, and what keeps almost every existing call site unchanged (see
-- app/dataClient.js).
--
-- Run this once against the Neon database from its own SQL console, same
-- as schema.sql — there is no migration runner in this project.

create table if not exists users (
  cuid              text primary key,
  username          text not null unique,
  password_hash     text,
  password_salt     text,
  password_iters    int,
  first_name        text,
  -- LINE-authenticated accounts have no password (parity with the existing
  -- local-only LINE account convention: hash === null marks a LINE account).
  line_sub          text unique,
  line_picture      text,
  profile_complete  boolean not null default true,
  -- Null until the one-time local->server upload (api/migrate-upload.js)
  -- has run for this account. A later cutover phase must not let an
  -- unmigrated account start reading from the server before this is set.
  migrated_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists clients (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  name              text not null,
  phone             text,
  email             text,
  tags              text,
  notes             text,
  tax_id            text,
  billing_address   text,
  member_no         text,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_clients_user on clients(user_cuid);

-- ─── Phase 2: fan-out of the clients pattern to the remaining IndexedDB ────
-- stores (api/*.js + this file only — see the phase's own plan for why the
-- app/ side of the wiring, e.g. dataClient.js's camelCase<->snake_case
-- mapping, is deliberately deferred to a later step).
--
-- JSONB columns mirror an array/object already embedded on the IndexedDB
-- record as-is (subTasks/milestones/timeEntries on a job, lineItems/
-- paymentChannels on an invoice, the per-doc-type `fields` object on a
-- document) rather than normalizing into child tables — minimal
-- translation, same shape the client already reads/writes today.
--
-- Where a store's record carries its own client-set `createdAt` distinct
-- from `updatedAt` (bookings, portfolio, research, followups), that column
-- is deliberately left out of each api/*.js FIELDS list (same treatment
-- `updated_at` already gets everywhere) so it's assigned once by this
-- column's own `default now()` on insert and is never touched again by an
-- update — a server-assigned creation timestamp, not a client-trusted one.

create table if not exists jobs (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  date              text,
  client_name       text,
  client_id         text,
  service_id        text,
  service_name      text,
  job_type          text,
  amount            numeric,
  tip               numeric,
  expense           numeric,
  count             integer,
  notes             text,
  net_amount        numeric,
  stage_order       jsonb,
  stage             text,
  complete          boolean not null default false,
  invoice_id        text,
  quote_doc_id      text,
  package_id        text,
  sub_tasks         jsonb,
  milestones        jsonb,
  time_entries      jsonb,
  timer_started_at  timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_jobs_user on jobs(user_cuid);

create table if not exists services (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  name              text not null,
  rate              numeric,
  unit              text,
  usage_qty         integer,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_services_user on services(user_cuid);

create table if not exists invoices (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  number            text,
  issue_date        text,
  due_date          text,
  client_id         text,
  client_name       text,
  client_tax_id     text,
  client_address    text,
  line_items        jsonb,
  subtotal          numeric,
  wht_pct           numeric,
  vat_pct           numeric,
  vat               numeric,
  wht               numeric,
  client_pays       numeric,
  you_receive       numeric,
  deposit_pct       numeric,
  status            text,
  payment_channels  jsonb,
  notes             text,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_invoices_user on invoices(user_cuid);

create table if not exists documents (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  type              text,
  title             text,
  client_id         text,
  client_name       text,
  invoice_id        text,
  fields            jsonb,
  content           text,
  number            text,
  issue_date        text,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_documents_user on documents(user_cuid);

-- Named `app_bookings`, not `bookings` — schema.sql (the LINE self-service
-- booking pilot, a separate single-tenant schema) already owns the bare
-- `bookings` name; both schemas can load into the same Neon database.
create table if not exists app_bookings (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  customer_id       text,
  title             text,
  date              text,
  start_time        text,
  duration_min      integer,
  travel_buffer_min integer,
  location          text,
  notes             text,
  status            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_app_bookings_user on app_bookings(user_cuid);

create table if not exists followups (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  key               text,
  dismissed         boolean not null default false,
  snoozed_until     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_followups_user on followups(user_cuid);

create table if not exists portfolio (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  title             text not null,
  description       text,
  tags              text,
  image_data_url    text,
  order_index       integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_portfolio_user on portfolio(user_cuid);

create table if not exists research (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  title             text not null,
  category          text,
  body              text,
  is_premium        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_research_user on research(user_cuid);

create table if not exists packages (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  client_id         text,
  total_sessions    integer,
  price             numeric,
  purchased_date    text,
  expires_at        text,
  notes             text,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_packages_user on packages(user_cuid);

create table if not exists progress_logs (
  cuid              text primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  client_id         text,
  date              text,
  weight            numeric,
  notes             text,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_progress_logs_user on progress_logs(user_cuid);

-- One-key-at-a-time, matching the client's own saveSetting(key, val) pattern
-- (rather than one giant row per user) — no `cuid` here, the natural key is
-- (user_cuid, key). No special encryption at this layer despite some keys
-- holding PII-adjacent plaintext (PromptPay IDs, tax IDs in
-- paymentChannels/sellerTaxId) — matches this migration's posture elsewhere;
-- lib/crudHandler.js's error path already never logs body/field values, so
-- a failed request here never leaks a settings value to the server log.
create table if not exists settings (
  user_cuid         text not null references users(cuid) on delete cascade,
  key               text not null,
  value             jsonb,
  updated_at        timestamptz not null default now(),
  primary key (user_cuid, key)
);

create index if not exists idx_settings_user on settings(user_cuid);

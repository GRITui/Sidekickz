-- Sidekick — core app schema (Phase 1 of the local-first -> backend migration)
--
-- `cuid` is the real primary key throughout, matching the client-generated
-- UUID (`cuid()` in app/app.js) every record already carries today. The
-- client keeps minting its own id exactly as it does now; the server only
-- validates and inserts. That is what makes the one-time local->server
-- upload (api/migrate-upload.js) idempotent via `on conflict (cuid) do
-- nothing`, and what keeps almost every existing call site unchanged (see
-- app/dataClient.js).
--
-- Run this once against the Neon database from its own SQL console — there
-- is no migration runner in this project.
--
-- 2026-07-14: `sql/schema.sql` (the formerly-separate, explicitly
-- single-tenant LINE self-service-booking pilot schema) is retired and its
-- tables folded in below as real multi-tenant tables, per the "generic LINE
-- OA connection" build — see the LINE INTEGRATION section further down.
-- That file's own `create table if not exists services (...)` used the
-- *bare* name `services`, which — contrary to this file's previous header
-- comment claiming the two "would collide" (future tense, as if already
-- prevented) — was a real, never-actually-avoided collision: this file
-- already defined its own, differently-shaped `services` table below. Since
-- `sql/schema.sql` was still only "tracked, not started" (per the project
-- changelog's LINE integration entry — Vercel deploy access was never
-- available to actually run it), nothing live ever depended on its
-- single-tenant shape, so no data migration is needed to retire it — this
-- is a from-scratch definition, not a breaking change to a populated table.

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
  created_at        timestamptz not null default now(),
  -- ─── Subscription (Phase 0, 2026-07-14) ──────────────────────────────
  -- 'basic' | 'pro' | 'team' — Team billing (seats/orgs) is Phase 2, not
  -- built yet; this column exists now so Phase 1 gating has somewhere to
  -- read from. subscription_status: 'trialing' | 'active' | 'past_due' |
  -- 'canceled'. Default is 'active' with no trial clock (not 'trialing')
  -- specifically so this ALTER grandfathers every pre-existing account —
  -- see the trial-fields default below, and lib/entitlements.js, for why
  -- that matters: nobody using the app before this shipped should hit a
  -- surprise lock. New registrations (api/auth-register.js) explicitly
  -- override both to start a real 15-day trial instead of relying on this
  -- default. trial_ends_at is the ONLY thing lib/entitlements.js checks
  -- against the clock — a 'trialing' row with a null trial_ends_at (should
  -- never happen post-registration, but is possible if this default is
  -- ever hit some other way) is treated as never-expiring, not locked.
  plan                  text not null default 'basic' check (plan in ('basic','pro','team')),
  subscription_status   text not null default 'active' check (subscription_status in ('trialing','active','past_due','canceled')),
  trial_ends_at         timestamptz,
  stripe_customer_id    text,
  stripe_subscription_id text,
  current_period_end    timestamptz
);

-- Idempotent by design (`add column if not exists`) so this can be re-run
-- safely against the already-live production table — same by-hand
-- apply-once convention as the rest of this file (no migration runner
-- exists in this project). A fresh `create table` above already includes
-- these columns for anyone standing up the schema from scratch; this
-- block only matters for the existing deployed database.
alter table users add column if not exists plan text not null default 'basic';
alter table users add column if not exists subscription_status text not null default 'active';
alter table users add column if not exists trial_ends_at timestamptz;
alter table users add column if not exists stripe_customer_id text;
alter table users add column if not exists stripe_subscription_id text;
alter table users add column if not exists current_period_end timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_plan_check') then
    alter table users add constraint users_plan_check check (plan in ('basic','pro','team'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_subscription_status_check') then
    alter table users add constraint users_subscription_status_check check (subscription_status in ('trialing','active','past_due','canceled'));
  end if;
end $$;

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

-- ─── LINE INTEGRATION (2026-07-14: generic per-account connection) ────────
-- Retires sql/schema.sql's single-tenant pilot (one hardcoded Channel via
-- env vars, no tenant column anywhere) — see this file's own header note.
-- Every account can now connect its own LINE Official Account (a Messaging
-- API channel, a different channel type from the app-wide "Continue with
-- LINE" *Login* channel lib/lineLogin.js talks to — unrelated, unaffected).

-- One connected Messaging API channel per account (1:1 for now — a second
-- connected channel per account isn't a case this pass supports).
-- `bot_user_id` is LINE's own userId for this channel, resolved once via
-- GET /v2/bot/info at connect time (api/line-channel-connect.js) — this is
-- what api/line-webhook.js matches an inbound event's `destination` field
-- against to route ONE shared webhook URL back to the right account,
-- without trusting any client-supplied identifier. `channel_secret` is
-- required to verify that same inbound webhook's signature, so it has to
-- be stored (not just the access token) — same sensitivity posture the
-- `settings` table's header comment above already accepts for other
-- PII-adjacent plaintext, no separate encryption layer added here either.
-- `freelancer_line_user_id` is optional and self-reported by the account
-- owner (their own personal LINE user ID, found in their webhook event
-- logs — there's no lookup-by-name API for it) so booking-request can push
-- them a "new booking" alert; booking still works fully without it.
create table if not exists line_channels (
  user_cuid                 text primary key references users(cuid) on delete cascade,
  channel_id                text not null unique,
  channel_secret             text not null,
  bot_user_id                text,
  freelancer_line_user_id    text,
  connected_at               timestamptz not null default now()
);

create index if not exists idx_line_channels_bot_user on line_channels(bot_user_id);

-- A freelancer's self-service-bookable time windows — distinct from
-- `app_bookings` above (their own internal calendar of scheduled work,
-- managed in-app): this is the smaller, simpler set of open slots they've
-- explicitly offered up for a client to grab via the public booking page.
-- 'open' -> free to request. 'held' -> a client just requested it, soft
-- reservation, releases automatically if hold_expires_at passes without a
-- booking. 'booked' -> confirmed, no further action needed.
create table if not exists availability_slots (
  id                bigint generated always as identity primary key,
  user_cuid         text not null references users(cuid) on delete cascade,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null check (ends_at > starts_at),
  status            text not null default 'open' check (status in ('open', 'held', 'booked')),
  hold_expires_at   timestamptz
);

create index if not exists idx_availability_slots_open
  on availability_slots (user_cuid, starts_at)
  where status = 'open';

-- An incoming self-service request against one of the slots above.
-- `service_cuid` points at this same file's own `services` table (the
-- account's already-existing Service catalog, rate/name) — no separate,
-- narrower services table for the booking page, unlike the old pilot
-- schema; a freelancer manages one service list, used everywhere.
create table if not exists bookings (
  id                    bigint generated always as identity primary key,
  user_cuid             text not null references users(cuid) on delete cascade,
  slot_id               bigint not null references availability_slots(id),
  service_cuid          text references services(cuid),
  client_name           text not null,
  -- Nullable on purpose: a client arriving via a non-LINE channel (a
  -- shared link outside the LINE rich menu) has no LINE user ID at all.
  client_line_user_id   text,
  status                text not null default 'requested' check (status in ('requested', 'confirmed', 'declined')),
  created_at            timestamptz not null default now()
);

create index if not exists idx_bookings_user on bookings(user_cuid);

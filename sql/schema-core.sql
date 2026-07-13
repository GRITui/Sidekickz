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

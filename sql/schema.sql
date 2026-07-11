-- Sidekick × LINE — pilot schema (Step 0: self-service booking)
--
-- Pilot/single-tenant: no freelancer_id/tenant column anywhere here on
-- purpose. This is one freelancer's data for the pilot, not a generic
-- multi-tenant model — that's real, separate work (see the project
-- changelog's LINE integration entry), not something to half-build here.
--
-- Run this once against the Neon database from its own SQL console after
-- connecting the integration in Vercel. There is no migration runner in
-- this project yet — this file is the source of truth, applied by hand.

create table if not exists services (
  id            bigint generated always as identity primary key,
  name          text not null,
  price_thb     numeric(10, 2) not null check (price_thb >= 0),
  active        boolean not null default true
);

create table if not exists availability_slots (
  id                bigint generated always as identity primary key,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null check (ends_at > starts_at),
  -- 'open' -> free to request. 'held' -> a client just requested it, soft
  -- reservation, releases automatically if hold_expires_at passes without
  -- a booking. 'booked' -> confirmed, no further action needed.
  status            text not null default 'open' check (status in ('open', 'held', 'booked')),
  hold_expires_at   timestamptz
);

create index if not exists idx_availability_slots_open
  on availability_slots (starts_at)
  where status = 'open';

create table if not exists bookings (
  id                    bigint generated always as identity primary key,
  slot_id               bigint not null references availability_slots(id),
  service_id            bigint not null references services(id),
  client_name           text not null,
  -- Nullable on purpose: a client arriving via a non-LINE channel (an
  -- Instagram/Facebook bio link, not the LINE rich menu) has no LINE user
  -- ID at all. The freelancer alert push only fires when this is set.
  client_line_user_id   text,
  status                text not null default 'requested' check (status in ('requested', 'confirmed', 'declined')),
  created_at            timestamptz not null default now()
);

-- Example seed for the pilot freelancer — replace with real values by hand
-- in Neon's SQL console. Not something this codebase auto-populates.
--
-- insert into services (name, price_thb) values
--   ('Wellness coaching session', 1500.00),
--   ('Package of 4', 5400.00);
--
-- insert into availability_slots (starts_at, ends_at) values
--   ('2026-07-16 10:00+07', '2026-07-16 11:00+07'),
--   ('2026-07-16 14:00+07', '2026-07-16 15:00+07');

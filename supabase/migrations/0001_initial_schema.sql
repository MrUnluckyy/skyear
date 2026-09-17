-- SkyEar initial schema.
--
-- Column shapes come from real agent output (events.jsonl / passes.jsonl), not
-- from guesswork. The privacy rules in CLAUDE.md are enforced here, in the
-- database, rather than in the UI: exact sensor coordinates never leave this
-- schema, and the public views coarsen and delay what they expose.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- devices --
-- One agent install. The cloud holds a token HASH and an APPROXIMATE point.
-- It never holds a camera address or credential (invariant 1).
create table devices (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,      -- sha256 of the device token
  approx_point  geography(point, 4326),    -- coarsened; see public_sensors
  status        text not null default 'pending'
                check (status in ('pending', 'active', 'revoked')),
  agent_version text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index devices_owner_idx on devices (owner_id);

-- ---------------------------------------------------------------- sensors --
-- Exact position lives here and is readable only by the owner. Everything
-- public reads through public_sensors, which rounds it.
create table sensors (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references devices (id) on delete cascade,
  camera_id       text not null,           -- matches config.yaml cameras[].id
  exact_point     geography(point, 4326) not null,
  elevation_m     double precision not null default 0,
  mount_height_m  double precision not null default 0,
  created_at      timestamptz not null default now(),
  unique (device_id, camera_id)
);
create index sensors_device_idx on sensors (device_id);

-- ------------------------------------------------------------- detections --
-- One acoustic event. Field names mirror the agent's event dict exactly.
create table detections (
  id             uuid primary key default gen_random_uuid(),
  event_id       text not null,            -- agent-side id, for idempotent ingest
  sensor_id      uuid not null references sensors (id) on delete cascade,
  device_id      uuid not null references devices (id) on delete cascade,
  class          text not null default 'unknown'
                 check (class in ('unknown', 'aircraft', 'drone', 'noise')),
  confidence     real,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  duration_s     real not null,
  peak_db        real,
  floor_db       real,
  snr_db         real,
  dominant_hz    real,
  octave_db      jsonb,                    -- {"50-100": -31.3, ...}
  embedding      jsonb,                    -- optional, opt-in
  -- best ADS-B match at emission time, denormalised for query speed
  match_hex      text,
  match_flight   text,
  match_type     text,
  match_slant_m  integer,
  match_alt_m    integer,
  match_bearing  smallint,
  match_delay_s  real,
  has_clip       boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (device_id, event_id)
);
create index detections_sensor_time_idx on detections (sensor_id, started_at desc);
create index detections_class_time_idx  on detections (class, started_at desc);

-- ----------------------------------------------------------------- passes --
-- Every aircraft that came within pass_radius_m, heard or not. This table is
-- the project's core metric: detection rate and real range per aircraft type.
create table passes (
  id             uuid primary key default gen_random_uuid(),
  sensor_id      uuid not null references sensors (id) on delete cascade,
  device_id      uuid not null references devices (id) on delete cascade,
  hex            text not null,
  flight         text,
  aircraft_type  text,
  registration   text,
  closest_at     timestamptz not null,
  min_slant_m    integer not null,
  alt_m          integer,
  elevation_deg  real,
  heard          boolean not null,
  event_ids      text[] not null default '{}',
  created_at     timestamptz not null default now(),
  unique (device_id, hex, closest_at)      -- idempotent ingest, no duplicates
);
create index passes_sensor_time_idx on passes (sensor_id, closest_at desc);
create index passes_type_heard_idx  on passes (aircraft_type, heard);

-- ---------------------------------------------------------- pairing codes --
-- Short-lived code the owner reads off the web app and types into the agent.
-- The agent trades it for a device token. The cloud never sees camera details.
create table pairing_codes (
  code        text primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references devices (id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index pairing_codes_owner_idx on pairing_codes (owner_id);

-- -------------------------------------------------------------------- RLS --
alter table devices       enable row level security;
alter table sensors       enable row level security;
alter table detections    enable row level security;
alter table passes        enable row level security;
alter table pairing_codes enable row level security;

-- Owners see only their own rows. No public policy on these tables at all:
-- anonymous access goes through the views below, never the base tables.
create policy devices_owner on devices
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy sensors_owner on sensors
  for all using (device_id in (select id from devices where owner_id = auth.uid()))
  with check (device_id in (select id from devices where owner_id = auth.uid()));

create policy detections_owner on detections
  for select using (device_id in (select id from devices where owner_id = auth.uid()));

create policy passes_owner on passes
  for select using (device_id in (select id from devices where owner_id = auth.uid()));

create policy pairing_owner on pairing_codes
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Writes arrive only through the ingest Edge Function using the service role,
-- which bypasses RLS. No client-side insert policy exists by design.

-- ------------------------------------------------------------ public views --
-- Invariant 4: approximate locations only, and coverage gaps must not be
-- readable off the map. Sensor points are snapped to a ~1 km grid.
create view public_sensors
with (security_invoker = true) as
select
  s.id,
  d.status,
  st_snaptogrid(s.exact_point::geometry, 0.01)::geography as approx_point,
  d.last_seen_at > now() - interval '15 minutes' as online
from sensors s
join devices d on d.id = s.device_id
where d.status = 'active';

-- Aircraft detections are public immediately. Drone detections are held back
-- and stripped of anything that would sharpen a targeting picture.
create view public_detections
with (security_invoker = true) as
select
  det.id,
  det.sensor_id,
  det.class,
  det.started_at,
  det.duration_s,
  case when det.class = 'drone' then null else det.match_flight end as match_flight,
  case when det.class = 'drone' then null else det.match_type   end as match_type,
  case when det.class = 'drone' then null else det.match_slant_m end as match_slant_m,
  det.match_bearing
from detections det
join devices d on d.id = det.device_id
where d.status = 'active'
  and det.class <> 'noise'
  and (det.class <> 'drone' or det.started_at < now() - interval '30 minutes');

grant select on public_sensors, public_detections to anon, authenticated;

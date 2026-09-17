-- Live listening state, one row per sensor, overwritten on every heartbeat.
--
-- The event stream only reports a sound once it has ended - the agent writes an
-- event after the release hysteresis, then uploads on the next cycle - so the
-- map was always showing the past. This is the present.
--
-- Deliberately not a history table. It is overwritten in place, so it cannot
-- grow, and there is no record of when a given sensor was quiet.

create table sensor_status (
  sensor_id     uuid primary key references sensors (id) on delete cascade,
  device_id     uuid not null references devices (id) on delete cascade,
  level_db      real,
  floor_db      real,
  excess_db     real,
  rising        boolean not null default false,
  event_active  boolean not null default false,
  event_s       real not null default 0,
  warm          boolean not null default false,
  reported_at   timestamptz not null default now()
);

alter table sensor_status enable row level security;

create policy sensor_status_owner on sensor_status
  for select using (device_id in (select id from devices where owner_id = auth.uid()));

-- Writes arrive only through the ingest Edge Function on the service role.
-- public_sensors (see 0006) exposes the state but not level_db: how loud it is
-- at a known location is more than the public needs, and for drone work later
-- it is exactly the sort of detail worth withholding. excess_db is safe because
-- it is relative to that sensor's own floor.

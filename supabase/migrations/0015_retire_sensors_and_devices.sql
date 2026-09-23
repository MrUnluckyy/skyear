-- Take a camera off the map without destroying what it measured.
--
-- Every foreign key here cascades: deleting a sensor deletes its detections
-- and passes, and deleting a device deletes everything beneath it. For a
-- project whose product is honest negatives - every aircraft that passed and
-- was NOT heard - that is the wrong default for an everyday "remove" button.
-- Somebody tidying up a duplicate would silently discard days of measurement.
--
-- So removal is retirement: the row stops appearing anywhere public, the agent
-- stops being served, and the history stays. Deleting for real remains
-- possible, but it is a separate and clearly destructive act.
--
-- This has an immediate use. Re-pairing a Klaipeda agent left its predecessor
-- behind as a device that will sit on the public map as permanently offline
-- forever, because nothing prunes stale rows. With strangers pairing, failing
-- and re-pairing, that accumulates.
alter table public.sensors
  add column if not exists retired_at timestamptz;

comment on column public.sensors.retired_at is
  'Non-null hides this sensor from every public view. History is kept; set back to null to restore.';

-- devices.status already exists and the public views already filter on
-- 'active', so retiring a device needs no new column. Note the side effect,
-- which is wanted: ingest rejects a device whose status is not active, so
-- retiring is also how a token is revoked.

create or replace view public.public_sensors
with (security_invoker = false) as
select
  s.id,
  d.status,
  s.label,
  round(extensions.st_y(extensions.st_snaptogrid(s.exact_point::extensions.geometry, 0.01))::numeric, 3) as lat,
  round(extensions.st_x(extensions.st_snaptogrid(s.exact_point::extensions.geometry, 0.01))::numeric, 3) as lon,
  coalesce(st.reported_at > now() - interval '45 seconds', false) as online,
  st.audio,
  coalesce(st.event_active, false) as hearing_now,
  coalesce(st.rising, false) as rising,
  coalesce(st.event_s, 0::real) as hearing_for_s,
  st.excess_db,
  coalesce(st.warm, false) as warm,
  st.reported_at
from public.sensors s
join public.devices d on d.id = s.device_id
left join public.sensor_status st on st.sensor_id = s.id
where d.status = 'active'
  and s.retired_at is null;

create or replace view public.public_sensor_conditions
with (security_invoker = false) as
select
  s.id as sensor_id,
  w.window_min,
  count(t.id)::int as events,
  count(t.id) filter (where t.truncated)::int as truncated,
  least(1.0, coalesce(sum(
    case when t.id is null then 0 else greatest(0, extract(epoch from (
      least(t.ended_at, now()) - greatest(t.started_at, now() - make_interval(mins => w.window_min))
    ))) end
  ), 0) / (w.window_min * 60.0))::float as duty
from public.sensors s
join public.devices d on d.id = s.device_id
cross join (values (15), (60)) as w(window_min)
left join public.detections t
  on t.sensor_id = s.id
 and t.ended_at > now() - make_interval(mins => w.window_min)
where d.status = 'active'
  and s.retired_at is null
group by s.id, w.window_min;

create or replace view public.public_type_stats
with (security_invoker = false) as
select
  p.sensor_id,
  coalesce(p.aircraft_type, 'unknown') as aircraft_type,
  count(*) as passes,
  count(*) filter (where p.heard) as heard,
  round(avg(p.min_slant_m))::integer as avg_slant_m
from public.passes p
join public.sensors s on s.id = p.sensor_id
join public.devices d on d.id = s.device_id
where d.status = 'active'
  and s.retired_at is null
  and p.excluded_reason is null
group by p.sensor_id, coalesce(p.aircraft_type, 'unknown');

-- public_sensor_stats iterates sensors directly, so it needs the same guard.
create or replace view public.public_sensor_stats
with (security_invoker = false) as
with bounds as (select now() - interval '24 hours' as since)
select
  s.id as sensor_id,
  (select count(*) from public.passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since
      and p.excluded_reason is null) as passes_24h,
  (select count(*) from public.passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since and p.heard
      and p.excluded_reason is null) as heard_24h,
  (select count(*) from public.detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as detections_24h,
  (select count(*) from public.detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since and t.likely_wind) as wind_24h,
  (select coalesce(sum(t.duration_s), 0::real) from public.detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as event_seconds_24h,
  (select greatest(extract(epoch from x.last_end - greatest(x.first_start, (select since from bounds))), 1::numeric)
     from (select max(t.ended_at) last_end, min(t.started_at) first_start
             from public.detections t, bounds b
            where t.sensor_id = s.id and t.started_at > b.since) x) as observed_seconds,
  (select max(t.started_at) from public.detections t where t.sensor_id = s.id) as last_detection_at,
  (select round(avg(t.floor_db)::numeric, 1) from public.detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as avg_floor_db,
  (select count(*) from public.passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since
      and p.excluded_reason is not null) as excluded_passes_24h
from public.sensors s
join public.devices d on d.id = s.device_id
where d.status = 'active'
  and s.retired_at is null;

-- public_detections joins devices but not sensors, so it needs the join added.
create or replace view public.public_detections
with (security_invoker = false) as
select
  det.id,
  det.sensor_id,
  det.class,
  det.started_at,
  det.duration_s,
  case when det.class = 'drone' then null::real else det.snr_db end as snr_db,
  case when det.class = 'drone' then null::real else det.dominant_hz end as dominant_hz,
  case when det.class = 'drone' then null::real else det.floor_db end as floor_db,
  case when det.class = 'drone' then null::real else det.low_tilt_db end as low_tilt_db,
  case when det.class = 'drone' then null::real else det.cpp_db end as cpp_db,
  case when det.class = 'drone' then null::real else det.f0_hz end as f0_hz,
  det.harmonic,
  case when det.class = 'drone' then null::jsonb else det.octave_db end as octave_db,
  case when det.class = 'drone' then null::text else det.match_flight end as match_flight,
  case when det.class = 'drone' then null::text else det.match_type end as match_type,
  case when det.class = 'drone' then null::integer else det.match_slant_m end as match_slant_m,
  case when det.class = 'drone' then null::integer else det.match_alt_m end as match_alt_m,
  case when det.class = 'drone' then null::smallint else det.match_bearing end as match_bearing,
  case when det.class = 'drone' then null::real else det.match_delay_s end as match_delay_s,
  det.truncated,
  case when det.class = 'drone' then null::real else det.comb_db end as comb_db,
  case when det.class = 'drone' then null::real else det.comb_f0_hz end as comb_f0_hz,
  case when det.class = 'drone' then null::smallint else det.n_harmonics end as n_harmonics,
  case when det.class = 'drone' then null::real else det.tonal_db end as tonal_db
from public.detections det
join public.devices d on d.id = det.device_id
join public.sensors s on s.id = det.sensor_id
where d.status = 'active'
  and s.retired_at is null
  and det.class <> 'noise'
  and (det.class <> 'drone' or det.started_at < now() - interval '30 minutes');

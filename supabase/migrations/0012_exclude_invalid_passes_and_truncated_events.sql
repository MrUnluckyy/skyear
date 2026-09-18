-- Four corrections to figures that were quietly lying.
--
-- 1. THE MATCHING BLACKOUT. Between 2026-09-17 16:16:36Z and 2026-09-18
--    09:04:16Z the agent's sample-counted clock drifted ~3 h from wall time, so
--    emission-time geometry could not line a sound up with any aircraft. The
--    microphone was fine - 330 events were recorded in that window, at 40-50 dB
--    SNR - but 0 of them matched, and 62 passes were written as "not heard"
--    having never been given a chance. Those 62 false negatives dragged the
--    heard rate from ~44% to ~26% and produced the "BCS3 is quiet" result that
--    was reported as the project's strongest finding. It was an artefact.
--
--    The rows are kept, not deleted. They are evidence of the failure, and the
--    detector-side data in that window is still valid.
--
-- 2. TRUNCATED EVENTS. The detector caps an event at max_event_s (240 s), so a
--    continuous noise source is chopped into 240-second pieces, each stored as
--    a separate "unexplained sound". Nine such pieces on one afternoon inflated
--    both the unexplained count and the duty cycle.
--
-- 3/4. A duty cycle and a heard rate must be measured over the same window, and
--    the window that matters for "can I trust what I am seeing right now" is
--    minutes, not 24 hours. See public_sensor_conditions below.

-- 1 ---------------------------------------------------------------------
alter table public.passes
  add column if not exists excluded_reason text;

comment on column public.passes.excluded_reason is
  'Non-null means this pass cannot support a heard/not-heard conclusion. The row is retained; public views filter it out.';

update public.passes
set excluded_reason = 'agent clock drift: matching was inoperative, heard=false is not evidence'
where closest_at > timestamptz '2026-09-17 16:16:36.4+00'
  and closest_at < timestamptz '2026-09-18 09:04:16.9+00'
  and excluded_reason is null;

-- 2 ---------------------------------------------------------------------
alter table public.detections
  add column if not exists truncated boolean not null default false;

comment on column public.detections.truncated is
  'The event hit the detector''s max_event_s cap, so it is a slice of something longer, not a whole sound.';

-- Backfill. 240 s is the shipped default for max_event_s; a device configured
-- otherwise will be correct going forward because the agent now reports it.
update public.detections
set truncated = true
where duration_s >= 239.5 and truncated = false;

-- 3 ---------------------------------------------------------------------
-- Heard rate and duty cycle, both over the last 24 h, both with the invalid
-- window removed - so the number on the left and the number it must beat are
-- measured over the same evidence.
create or replace view public.public_sensor_stats
with (security_invoker = false) as
with bounds as (select now() - interval '24 hours' as since)
select
  s.id as sensor_id,
  (select count(*) from passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since
      and p.excluded_reason is null) as passes_24h,
  (select count(*) from passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since and p.heard
      and p.excluded_reason is null) as heard_24h,
  (select count(*) from detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as detections_24h,
  (select count(*) from detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since and t.likely_wind) as wind_24h,
  (select coalesce(sum(t.duration_s), 0::real) from detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as event_seconds_24h,
  (select greatest(extract(epoch from x.last_end - greatest(x.first_start, (select since from bounds))), 1::numeric)
     from (select max(t.ended_at) last_end, min(t.started_at) first_start
             from detections t, bounds b
            where t.sensor_id = s.id and t.started_at > b.since) x) as observed_seconds,
  (select max(t.started_at) from detections t where t.sensor_id = s.id) as last_detection_at,
  (select round(avg(t.floor_db)::numeric, 1) from detections t, bounds b
    where t.sensor_id = s.id and t.started_at > b.since) as avg_floor_db,
  -- Appended, not inserted: `create or replace view` cannot reorder columns,
  -- and dropping this view would cascade into everything that reads it.
  -- How much of the window is unusable, so the interface can say so rather than
  -- silently reporting a rate over a shrunken denominator.
  (select count(*) from passes p, bounds b
    where p.sensor_id = s.id and p.closest_at > b.since
      and p.excluded_reason is not null) as excluded_passes_24h
from sensors s
join devices d on d.id = s.device_id
where d.status = 'active';

-- Per aircraft type, same exclusion. This is the view that carried the BCS3
-- claim, so it is the one that most needed it.
create or replace view public.public_type_stats
with (security_invoker = false) as
select
  p.sensor_id,
  coalesce(p.aircraft_type, 'unknown') as aircraft_type,
  count(*) as passes,
  count(*) filter (where p.heard) as heard,
  round(avg(p.min_slant_m))::integer as avg_slant_m
from passes p
join sensors s on s.id = p.sensor_id
join devices d on d.id = s.device_id
where d.status = 'active'
  and p.excluded_reason is null
group by p.sensor_id, coalesce(p.aircraft_type, 'unknown');

-- 4 ---------------------------------------------------------------------
-- Conditions right now, per sensor.
--
-- The 24 h duty cycle hides exactly the thing a viewer needs: whether the map
-- is currently measuring anything or merely watching noise. On the afternoon
-- this view was written both sensors sat near 60% - six passes in ten would
-- coincide with a sound by chance - while the 24 h figure still read 19%.
--
-- Truncated slices are counted in the duty cycle (the sound really was present)
-- but reported separately, because as *events* they are one sound counted many
-- times.
create or replace view public.public_sensor_conditions
with (security_invoker = false) as
select
  s.id as sensor_id,
  w.window_min,
  count(t.id)::int as events,
  count(t.id) filter (where t.truncated)::int as truncated,
  -- Only the part of each event that falls inside the window.
  --
  -- The `t.id is null` guard is load-bearing. least() and greatest() ignore
  -- NULLs in Postgres, so for a sensor with no events at all the clamps
  -- collapse to `least(NULL, now())` = now() and `greatest(NULL, start)` =
  -- start - crediting a silent sensor with the entire window and reporting it
  -- as 100% saturated. Exactly backwards, and worst on a dead sensor.
  least(1.0, coalesce(sum(
    case when t.id is null then 0 else greatest(0, extract(epoch from (
      least(t.ended_at, now()) - greatest(t.started_at, now() - make_interval(mins => w.window_min))
    ))) end
  ), 0) / (w.window_min * 60.0))::float as duty
from sensors s
join devices d on d.id = s.device_id
cross join (values (15), (60)) as w(window_min)
left join detections t
  on t.sensor_id = s.id
 and t.ended_at > now() - make_interval(mins => w.window_min)
where d.status = 'active'
group by s.id, w.window_min;

grant select on public.public_sensor_conditions to anon, authenticated;

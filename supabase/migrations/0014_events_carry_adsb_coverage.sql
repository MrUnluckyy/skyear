-- An unmatched sound is the product; an unmatched sound with no ADS-B behind it
-- is nothing.
--
-- Aircraft detection is this project's validation, not its goal. A sound from
-- the air that ADS-B explains is a labelled negative; one it cannot explain is
-- where a drone suspicion starts. That inversion makes feed coverage a
-- first-class property of every event, because match_event drops every
-- candidate whose fix is older than max_fix_age_s - so while the feed is down,
-- every single event comes out unmatched. Without a record of the coverage, an
-- ADS-B outage does not merely degrade the data: it manufactures suspicions.
--
-- This is the same failure as the matching blackout in migration 0012, where a
-- drifting agent clock left 330 events unmatched and 62 passes falsely "not
-- heard". That one was found weeks later and corrected by hand. This column is
-- how the next one gets caught by a query instead.

alter table public.detections
  add column if not exists adsb_gap_s real;

comment on column public.detections.adsb_gap_s is
  'Seconds of this event''s matching window with no successful ADS-B poll behind them, counting the emission-time lookback. 0 means full coverage and an unmatched event is real evidence. Above 0 means matching was partly or wholly inoperative and "no aircraft match" is not evidence of anything. Null means the agent runs without ADS-B at all, or predates the field.';

-- Republished so the web app can tell an unexplained sound from a blind spot.
-- The value carries no location and needs no coarsening for drone rows.
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
  case when det.class = 'drone' then null::real else det.tonal_db end as tonal_db,
  det.adsb_gap_s
from public.detections det
join public.devices d on d.id = det.device_id
join public.sensors s on s.id = det.sensor_id
where d.status = 'active'
  and s.retired_at is null
  and det.class <> 'noise'
  and (det.class <> 'drone' or det.started_at < now() - interval '30 minutes');

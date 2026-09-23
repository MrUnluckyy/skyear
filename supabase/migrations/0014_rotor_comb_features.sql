-- Recovered from the database on 2026-09-23. Applied to Supabase as
-- `rotor_comb_features` (20260918132447) and never written back here, so it is
-- reproduced verbatim below. Its position matters: it adds the comb columns
-- that 0015's public_detections selects, so replaying the repo with this
-- appended at the end instead would fail on a fresh database.

-- Narrowband rotor structure, per detection.
--
-- The features already stored cannot see a propeller. octave_db has six bands
-- an octave wide, and a quadcopter's tones at 200/400/600/800 Hz land inside
-- two of them - the comb is not attenuated by that analysis, it is invisible to
-- it. cpp_db is the right idea and fails in the field: real propellers score
-- 0.066-0.077 against a threshold of 0.12 calibrated on synthesis at 0.228.
--
-- These come from integrating the whole event rather than a 0.5 s frame, and
-- autocorrelating a whitened spectrum to find harmonic SPACING - which survives
-- distance, because air absorption removes the top of a harmonic stack but does
-- not change the gap between what remains.
--
-- Measured on corrected synthesis at 0 dB SNR, this separates rotor sources
-- from wind, road noise and jets at AUC 1.000, and separates a drone from a
-- scooter at AUC 0.500. That second number is the honest one: both are small
-- engines turning a propeller in the same frequency range, and no single
-- microphone distinguishes them on spectrum. Anything red on the map has to
-- come from geometry, not from these columns.
alter table public.detections
  add column if not exists comb_db real,
  add column if not exists comb_f0_hz real,
  add column if not exists n_harmonics smallint,
  add column if not exists tonal_db real;

comment on column public.detections.comb_db is
  'Prominence of the best harmonic spacing, dB above the surrounding autocorrelation.';
comment on column public.detections.comb_f0_hz is
  'The spacing itself: a candidate blade-pass or engine firing rate.';
comment on column public.detections.n_harmonics is
  'How many multiples of comb_f0_hz carry a resolvable tone. 0 for wind, road noise and jets.';
comment on column public.detections.tonal_db is
  'Mean excess over a whitened baseline: how much of the band sits in narrow peaks.';

-- Published, because the whole point is that someone can check the claim.
-- Suppressed for drone-class rows along with everything else, per the existing
-- delay-and-coarsen rule.
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
from detections det
join devices d on d.id = det.device_id
where d.status = 'active'
  and det.class <> 'noise'
  and (det.class <> 'drone' or det.started_at < now() - interval '30 minutes');

-- What a sound's spectral tilt means, measured rather than assumed.
--
-- The first attempt at a "what could this be" diagram drew reference curves
-- from a physical model - wind collapsing above 100 Hz, a jet broad, a
-- propeller carrying into the middle bands. Checked against the stored events
-- they were fiction. Mean octave levels in dB, SNR > 12, 2026-09-18:
--
--                    50    100    200    400    800   1.6k    tilt
--   wind      n=204  11.7   0.3  -11.2  -24.2  -31.2  -40.5   23.0
--   aircraft  n= 56  10.2   2.0   -6.5  -17.5  -26.4  -34.5   16.7
--   unmatched n=304   8.0   0.1   -8.2  -18.9  -26.3  -34.4   16.2
--
-- Normalise those and the curves lie on top of each other: every source at this
-- site falls away monotonically at 8-12 dB per octave. The shape carries no
-- information about what made the sound. Only the STEEPNESS differs, and that
-- is exactly what low_tilt_db already measures - so the detector's existing
-- 20 dB wind threshold turns out to sit almost precisely between the wind p10
-- (20.4) and the confirmed-aircraft p90 (19.2), which is the first independent
-- validation it has had.
--
-- The unmatched population is the one that matters: its tilt distribution sits
-- on the aircraft, not on the wind. Whatever those sounds are, they are not the
-- filter leaking gusts.
--
-- security_invoker stays false for the same reason as the other public views:
-- RLS on detections filters rows and anon has no select policy there at all.
-- Nothing here is per-sensor or locatable; it is four numbers per population.
create or replace view public.public_spectrum_baseline
with (security_invoker = false) as
select
  case
    when likely_wind then 'wind'
    when match_flight is not null then 'aircraft'
    else 'unmatched'
  end as population,
  count(*)::int as n,
  round(percentile_cont(0.1) within group (order by low_tilt_db)::numeric, 1)::float as p10,
  round(percentile_cont(0.5) within group (order by low_tilt_db)::numeric, 1)::float as p50,
  round(percentile_cont(0.9) within group (order by low_tilt_db)::numeric, 1)::float as p90
from public.detections
where low_tilt_db is not null
  -- Weak events carry an unreliable tilt; the band estimate needs signal.
  and snr_db > 12
  and started_at > now() - interval '30 days'
group by 1
-- A handful of events is not a distribution.
having count(*) >= 20;

grant select on public.public_spectrum_baseline to anon, authenticated;

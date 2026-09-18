-- Let an owner name a sensor.
--
-- Until now sensors were "Sensor 1" and "Sensor 2", numbered by their position
-- in whatever order PostgREST returned - so the numbers swapped between polls
-- and the panel looked as though it had jumped to a different sensor. A stable
-- identity has to come from the row, not from the list.
--
-- The label is published. That is the tradeoff worth recording: a name like
-- "the shed" is harmless, "Justas, Vilnius" is an address and a person, and the
-- interface has to say so where the name is typed. 40 characters is enough for
-- a place and short of a sentence.
alter table public.sensors
  add column if not exists label text
  check (label is null or length(label) between 1 and 40);

-- Republished with the label. security_invoker stays false: RLS on sensors
-- filters rows, and the point of this view is to expose a snapped position
-- without exposing exact_point - see 0006.
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
where d.status = 'active';

grant select on public.public_sensors to anon, authenticated;

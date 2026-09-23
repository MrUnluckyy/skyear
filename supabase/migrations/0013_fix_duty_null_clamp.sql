-- Recovered from the database on 2026-09-23. Applied to Supabase as
-- `fix_duty_null_clamp` (20260918131453) and never written back here, so it is
-- reproduced verbatim below. It has to sit before 0015, which rebuilds views
-- that depend on this one existing.

-- least()/greatest() ignore NULLs, so an empty left join produced
-- least(NULL, now()) = now() and greatest(NULL, start) = start, crediting a
-- sensor with zero events with the whole window and reporting it at 100% duty.
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
from sensors s
join devices d on d.id = s.device_id
cross join (values (15), (60)) as w(window_min)
left join detections t
  on t.sensor_id = s.id
 and t.ended_at > now() - make_interval(mins => w.window_min)
where d.status = 'active'
group by s.id, w.window_min;

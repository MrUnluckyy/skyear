-- Absence is not a denial.
--
-- `not null default false` meant every agent older than the field reported
-- audio = false, and the map accused perfectly healthy sensors of receiving no
-- sound while they sat there measuring a noise floor. The fleet always lags the
-- server, so a field the fleet may not send has to be nullable, and the
-- interface has to say "not reported" rather than "broken".
alter table public.sensor_status
  alter column audio drop not null,
  alter column audio drop default;

update public.sensor_status set audio = null where audio = false;

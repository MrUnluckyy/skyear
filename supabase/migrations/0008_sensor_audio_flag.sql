-- Whether sound is actually reaching the detector.
--
-- A quiet sensor is ambiguous: quiet sky, or dead camera? Without this the map
-- could not tell an operator which one they were looking at, and the honest
-- answer to "why does it say no detections" was a shrug.
alter table public.sensor_status
  add column if not exists audio boolean not null default false;

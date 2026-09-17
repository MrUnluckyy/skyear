-- Periodicity per detection, kept because it is training data.
--
-- cpp_db is cepstral peak prominence: how strongly the sound repeats. f0_hz is
-- the fundamental implied by that peak, which for a two-stroke is its firing
-- frequency.
--
-- Calibrated against real recordings and synthetic sources:
--
--   piston engine, 12 harmonics   0.228   <- the Shahed signature
--   piston at  0 dB SNR in wind   0.148
--   piston at -6 dB SNR in wind   0.126   <- quieter than the wind, still clear
--   our own field recordings      0.060-0.101
--   wind                          0.053
--   white noise                   0.051
--   synthetic turbofan (3 tones)  0.063
--
-- The last line is the caveat worth keeping: this separates DENSE harmonic
-- stacks from noise, so it is strong for piston drones and weak for jets. It
-- found no separation between our aircraft-matched and unmatched events.
--
-- Recorded on every event, noise included, because a labelled corpus of what
-- the wind sounds like here is exactly what a classifier needs as negatives.

alter table detections
  add column if not exists cpp_db   real,
  add column if not exists harmonic boolean not null default false,
  add column if not exists f0_hz    real;

create index if not exists detections_harmonic_idx
  on detections (harmonic, started_at desc) where harmonic;

-- public_detections republished with cpp_db, f0_hz and harmonic. Published for
-- aircraft, withheld for drones like the other acoustics: the fundamental of a
-- drone's engine is a fingerprint of the airframe.

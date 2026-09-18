# Becoming a drone detector

## The problem with "unexplained"

The map's headline concept is a sound with no transponder-equipped aircraft
overhead. For finding aircraft that is a good category. For finding drones it is
much weaker than it sounds, because the following all land in it:

- scooters and motorcycles
- cars, vans, lorries
- construction, generators, leaf blowers, lawnmowers
- rain on a roof, hail, thunder
- aircraft without ADS-B — gliders, microlights, some military, some GA
- birds, dogs, people
- the wind, whenever the tilt filter is wrong

"Unexplained" means *unexplained by ADS-B*. On this network it is currently
around 300 events against 56 confirmed aircraft, so the category is dominated by
things that were never going to be in ADS-B in the first place.

Making this a drone detector means turning that category from "everything we
could not name" into "things we have positively ruled the alternatives out for."

## What was measured, and what it rules out

`skyear/rotor.py` finds harmonic spacing by integrating a whole event, whitening
the spectrum so only narrow peaks survive, and autocorrelating along frequency.
Spacing is the right quantity because it survives distance: air absorption
removes the top of a harmonic stack but does not change the gap between what
remains.

Evaluated by `tools/rotor_eval.py` on synthesis at 0 dB SNR:

| comparison | AUC | reading |
|---|---|---|
| rotor source vs wind | 1.000 | perfect |
| rotor source vs road noise | 1.000 | perfect |
| rotor source vs jet aircraft | 1.000 | perfect |
| **drone vs scooter** | **0.500** | **chance** |

The first three are genuinely useful: the feature reliably answers "is something
turning?" and the existing octave and cepstral features cannot.

The fourth is the finding that shapes everything else. A Shahed-136 is a
two-stroke piston driving a pusher propeller with a fundamental near 90 Hz. A
scooter is a two-stroke driving a wheel with a fundamental near 100 Hz. They
occupy the same band with the same harmonic structure. **One microphone cannot
separate them on spectrum, and no amount of model architecture changes that** —
the information is not in the signal.

So the interface reports "rotor signature" and never a percentage. A number like
"87% drone" would be invented, and a red dot is exactly where an invented number
does damage.

## Where the separation actually is

Three discriminators exist, in increasing order of strength.

### 1. Context (weak, free)

Shahed-type attacks come at night, when road noise collapses. A rotor signature
at 03:00 with a 5% duty cycle is worth far more than the same signature at 17:00
at 60%. This is a prior, not evidence, but it is free and it is already
measurable — `public_sensor_conditions` publishes exactly the number needed.

### 2. Persistence and envelope (moderate)

A scooter passes: ten to thirty seconds, sharp rise, sharp fall, Doppler sweep
through the harmonic stack as it goes by. A transiting UAV is minutes with a
smoother envelope, and a loitering one is longer still with almost none.

Requires: tracking `comb_f0_hz` over time within an event rather than
summarising it once. A Doppler sweep is a f0 that slides and returns; a drone
holding course is a f0 that drifts slowly. The current code reports one f0 per
event and throws the trajectory away.

### 3. Geometry across sensors (strong — the real answer)

**Ground vehicles are confined to roads. An aerial source is not.**

A scooter is loud at one sensor and inaudible at another two kilometres away,
because buildings and terrain are in the way and it is a low-power source near
the ground. A UAV at 300 m has line of sight to every sensor for kilometres.

So: *the same rotor signature arriving at three or more sensors within seconds,
where no road connects them, is not a scooter.* That inference needs no precise
timing and no array — only several sensors and a shared signature.

This is why the sensor network matters more than the classifier. Two sensors
give a weak version of this test. Five give a strong one.

## Why trajectory and a danger area are not next

Estimating a source position from arrival times needs the arrival times to be
right. From `CLAUDE.md`:

> Timestamps are `time.time()` at read and ignore RTSP latency (~0.5–2 s). Fine
> for aircraft matching; **not** good enough for multi-sensor trajectory
> estimation from arrival times. Fix before multilateration.

Sound travels 343 m/s. One second of timing error is 343 metres of position
error, and the current uncertainty is one to two seconds — so a multilaterated
position would be wrong by up to half a kilometre in an unknown direction. A
danger area drawn from that would be worse than no danger area, because people
would act on it.

Two things have to happen first:

1. **Bounded timestamp error.** Either RTSP RTCP sender reports for true capture
   time, or a per-camera latency calibration (play a known impulse, measure the
   offset), or NTP-disciplined agents with a measured constant offset. Target:
   under 100 ms, which is 34 m.
2. **Enough sensors.** Multilateration needs four for a 3D fix, or three plus an
   altitude assumption. There are currently two live.

Until then, the honest multi-sensor product is not a trajectory. It is
**corroboration** — "three sensors heard this within eight seconds" — plus a
coarse region from which sensors did and did not hear it. That is buildable now
and it is the thing that actually distinguishes a drone from a scooter.

## What has to be true before a dot turns red

All five, not any of them:

1. A rotor signature is present — `n_harmonics` above a calibrated threshold.
2. **The threshold was calibrated against real drone audio** recorded through a
   real camera microphone at a real distance. This does not exist yet, and
   `tools/rotor_eval.py` will refuse to print a threshold until it does.
3. At least two sensors, ideally three, heard a compatible signature within a
   plausible propagation window.
4. No ADS-B aircraft accounts for it.
5. Conditions are not saturated — a detection at 60% duty cycle is coincidence.

Condition 2 is the blocking one and it is not a code problem.

## The blocking experiment

**Fly a drone past a sensor and record it.** Nothing downstream can be
calibrated without a positive class, and a speaker cannot substitute: a speaker
at two metres delivers the whole spectrum, while three kilometres of air removes
the top of it. This is exactly the mistake that gave `cpp_db` a threshold of
0.12 that no real aircraft has ever reached.

What to capture, in rough order of value:

| recording | why |
|---|---|
| any multirotor, 50–300 m, several passes | the positive class; nothing starts without it |
| the same drone at increasing distance until inaudible | the range curve, and where the comb dies |
| the same drone heard by two sensors at once | proves the corroboration test |
| a scooter and a motorcycle passing nearby | the hard negative, from the real environment |
| a lawnmower or generator | a stationary rotor source, the other hard negative |
| night-time ambient, an hour | the negative class that matters for the real use case |

Save as 16-bit WAV into `corpus/<label>/` and run:

```bash
python tools/rotor_eval.py --corpus corpus/
```

It will report separation per class and, if there is a real positive class and
the weakest AUC clears 0.8, suggest a threshold against the *hardest* negative
rather than an easy one — and say plainly when the false alarm rate is too high
to turn a dot red.

## Order of work

1. Record a drone. Everything is blocked on this.
2. Track `comb_f0_hz` within an event, so envelope and Doppler become available.
3. Cross-sensor corroboration: same signature, several sensors, short window.
   Buildable now, no timing fix needed, and it is the strongest available
   discriminator.
4. Fix timestamp error to under 100 ms.
5. More sensors. Four is the minimum for a position without assumptions.
6. Only then: trajectory, and only then a danger area.

A red dot before step 3 would be a guess with a colour on it.

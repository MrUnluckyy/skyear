# SkyEar: handover

## Goal
Use existing home and municipal security cameras as acoustic sensors that detect
aircraft, and eventually drones such as Shahed-type UAVs. Show detections on a
live map. Aircraft near Vilnius airport are the first real use case, because
ADS-B provides ground-truth labels automatically.

The project complements droneradar.app (Mainline BV), which uses spare phones.
Fixed outdoor sensors give it something that network lacks, so contributing data
to droneradar is a later option.

## Hardware verified so far
- Reolink camera at `192.168.1.50`, reachable over HTTP (port 80) and RTSP
  (port 554) with user `admin`. The password is not stored here.
- Stream `rtsp://admin:***@192.168.1.50:554/Preview_01_sub` carries H.264 video
  and AAC audio, 16 kHz, mono.
- NAS: Synology (runs Container Manager). A spare camera is available, and a
  friend in another city will run a second agent.
- In Chrome on macOS the camera fails with `ERR_ADDRESS_UNREACHABLE` because of
  the Local Network privacy permission. curl works.

## Acoustic test results (`Preview_01_sub`)
| Test | Result |
|---|---|
| Steady 150 Hz tone, 50 s | ✅ flat within ±1.5 dB, no noise suppression; ~22 dB above background |
| Sweep response | ✅ usable from ~50 Hz upward; strongest 60–95 Hz. Unevenness above 300 Hz is probably speaker/room, not separated yet |
| Electrical hum | ⚠️ intermittent 100 Hz band, about −64 to −73 dB (twice the mains frequency), source unknown. May need filtering at 100 Hz and multiples |
| Recording level | ⚠️ low: peak around −29 dBFS during the tone test |
| Gain control | ❓ not tested (step the volume, check the recorded level follows) |
| Range outdoors / wind | ❓ not tested; this is the test that decides the project |

## Architecture decisions
1. **Edge agent, not cloud ingestion of cameras.** Camera IP addresses and passwords
   never leave the user's network. The website never asks for them. Reasons:
   cloud servers can't reach private LAN addresses; credentials the server can
   decrypt aren't really protected; a central credential store is a target for
   state actors.
2. **Agent onboarding happens locally** (camera type → IP → username → password),
   later through a local web UI on the agent. The cloud only ever sees a
   revocable device token, obtained with a pairing code.
3. **Only events leave the device:** time, class, confidence, matched aircraft,
   approximate location, and optionally embeddings. Clips go to the cloud only
   with explicit opt-in, and clips containing speech are discarded.
4. **The public map shows approximate sensor locations** and should hide coverage
   gaps, since those help an attacker. Delay or coarsen public drone detections.
5. **ADS-B gives self-labelling ground truth.** Sound events are matched to
   aircraft positions at emission time (distance ÷ 343 m/s).
6. **Stack:** Python agent in Docker (works on Synology x86 and Raspberry Pi
   arm64) → Supabase (Postgres + PostGIS, row-level security, Edge Functions,
   Realtime, private Storage) → React + TypeScript on Vercel, MapLibre with
   OpenStreetMap tiles.
7. **Later:** a Raspberry Pi kit (Pi + RTL-SDR + readsb) sold at cost, which needs
   a non-profit entity and CE/RED, WEEE, and GDPR work. Municipal cameras come
   in phase 2 and need a GDPR impact assessment for audio.
8. **Public alerts:** no push warnings without talking to the Fire and Rescue
   Department and military first. Show verified detections on the map only.

## Current code (v0.1, this repo)
```
skyear/audio.py     ffmpeg RTSP/file → PCM chunks; reconnect with backoff; URL builder for reolink|hikvision|dahua|generic; logs hide credentials
skyear/detector.py  adaptive band-energy detector (50–2000 Hz, percentile noise floor, min duration, hysteresis); octave-band features per event
skyear/adsb.py      ADS-B poller: adsb.lol (/v2/lat/{lat}/lon/{lon}/dist/{nm}), airplanes.live (/v2/point/...), local readsb aircraft.json; per-aircraft track history + interpolation
skyear/matcher.py   match_event (emission-time geometry: slant, elevation, bearing, delay); PassTracker (closest approach per aircraft → heard/not-heard)
skyear/geo.py       haversine, bearing, slant geometry
skyear/main.py      config, per-camera threads, ring buffer → WAV clips, events.jsonl / passes.jsonl, clip cleanup, --check, --replay
```
Config lives in `config.yaml` (template `config.example.yaml`). Passwords go in
`.env` via `password_env`. Both files are gitignored.

**Verified in a sandbox:** the detector catches synthetic engine passes and
ignores a 1 s click. Matcher on a simulated A220 at 2 km / 1000 m gave slant
2171 m (expected 2173 m) and delay 6.3 s; the pass was marked heard.

**Not verified:** Docker build, a live RTSP stream, the live adsb.lol API.

Commands:
```bash
docker compose build
docker compose run --rm skyear --check     # camera audio + ADS-B reachability
docker compose up -d && docker logs -f skyear-agent
python -m skyear.main --config config.yaml --data ./out --replay rec.wav
```

## Known gaps and TODO in the agent
- [ ] Run `--check` and a 24 h live run; tune `threshold_db` / `min_duration_s` against real passes
- [ ] Optional notch filter at 100 Hz and harmonics (hum)
- [ ] Wall-clock timestamps are `time.time()` at read, ignoring RTSP latency (~0.5–2 s). Fine for aircraft matching; not enough for multi-sensor trajectory estimation from arrival times
- [ ] Speed of sound is fixed at 343 m/s; add temperature correction
- [ ] Rate-limit handling and backoff for ADS-B providers; confirm current terms
- [ ] Speech detection before any clip upload
- [ ] Local web UI for camera onboarding (encrypt credentials at rest on device)
- [ ] Unit tests (detector, matcher geometry, pass tracker) from the sandbox scripts
- [ ] Multi-arch image build (amd64 + arm64)

## Next milestones
1. **Live validation** on the Synology: a few days of events and passes.
2. **Backend (Supabase):**
   - Tables: `devices` (owner, token hash, approximate location, status), `sensors`
     (device, exact location kept private, public geohash), `detections` (event
     fields + matched aircraft), `passes`, `pairing_codes`
   - Row-level security: owners see their own devices; public reads only a coarse view
   - Edge Function `ingest`: device token auth, validation, rate limiting
   - Realtime broadcast of new detections
3. **Agent → cloud:** pairing flow and event upload with a retry queue.
4. **Web app:** live ADS-B aircraft layer, approximate sensors, detection lines
   (sensor → aircraft), event feed, per-sensor stats (detection rate, max range
   per aircraft type).
5. **Second site:** the friend's agent.
6. **ML v0.2:** fine-tune PANNs/BEATs/EfficientAT on ADS-B-labelled clips
   (heard vs. not heard, then jet / turboprop / helicopter), export to ONNX,
   run on the device.

## Open questions
- Gain control behaviour on the Reolink
- Real outdoor detection range per aircraft type
- Source of the 100 Hz hum
- Whether droneradar would accept data from fixed sensors
- Project name (working name "SkyEar") and language of the UI (LT/EN)

---

## Session log

### 2026-09-17 — first live run, agent under version control
Appended by Claude Code. Original text above is unchanged.

**Repo:** the v0.1 code was never in this repo — it was loose in
`~/Downloads/skyear-agent.zip`. Now under git in a monorepo layout
(`agent/`, `web/`, `supabase/`, `docs/`) with `CLAUDE.md` recording the
privacy invariants and 74 unit tests.

**Three faults the live run found**, none of which crashed anything — all would
have silently corrupted the dataset:

| Fault | Effect if left running |
|---|---|
| Parked transponders at VNO report a frozen fix timestamp, so `PassTracker` closed the pass on staleness and reopened it on the same tick | An identical pass record every 5 s; airport ground vehicles would have outnumbered real aircraft and made the heard/not-heard ratio meaningless |
| `match_event` had no ground/staleness filter | The first real event was labelled `ADSTEST` — a ground beacon. Apron transponders sit at a constant 3–4 km and win the nearest-slant sort, so they would have stolen the label from every detection, and those labels are what ML v0.2 trains on |
| Wind gusts scored 38–40 dB SNR and would have overlapped aircraft arrival windows | Gusts would mark aircraft as **heard**, inflating the detection rate with noise — failing in the direction that says the project works |

**Wind signature (new measurement).** Two gusts, 11:27 and 11:31:
dominant 56–57 Hz pinned at the band edge, energy falling ~39 dB from 50–100 Hz
to above 400 Hz. Now measured as `low_tilt_db` (50–100 minus 200–400) and tagged
`likely_wind` above 20 dB. Synthetic engine sits at −43 dB, wind at +27 dB.
**The aircraft side of that threshold is unvalidated** — it needs one confirmed
real detection.

**Acoustic result so far: no aircraft detected.** `BTI34K` at 2.5 km / 343 m and
`BTI98T` at 3.7 km / 221 m both `not heard`. Too few samples to conclude, and
the ambient floor was unsettled (−9 to −24 dB across restarts), but this is the
decisive open question and it now has real numbers attached.

**ADS-B:** `adsb.lol` returns 429 even at a 10 s poll interval. Exponential
backoff and `Retry-After` are implemented, so it degrades gracefully, but track
history gets gappy. Worth testing `airplanes.live`, or moving up the local
`readsb` + RTL-SDR plan sooner than phase 2.

**Closed from the TODO list:** unit tests; ADS-B rate-limit backoff.
**New:** replay mode timestamps start at epoch 0, so `start_iso` reads 1970.

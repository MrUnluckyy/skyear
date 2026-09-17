# SkyEar (repo: `dronar`)

Turn existing home and municipal security cameras into a network of acoustic
sensors that detect aircraft — and eventually drones such as Shahed-type UAVs —
and show detections on a live map.

First real use case: aircraft near Vilnius airport, because ADS-B gives
ground-truth labels automatically. See `HANDOVER.md` for full background,
test results, and open questions.

## Layout
```
agent/       Python edge agent (v0.1). Runs in Docker on Synology / Raspberry Pi.
web/         React + TypeScript + MapLibre on Vercel.      (not started)
supabase/    Postgres + PostGIS, RLS, Edge Functions.      (not started)
docs/        Design notes, measurements, compliance.
```

## Non-negotiable invariants

These are the architecture. Changing one is a project-level decision, not an
implementation detail — raise it, don't refactor it away.

1. **Camera credentials never leave the device.** No cloud ingestion of camera
   streams, no server-side credential store, no website field that asks for a
   camera IP or password. Cloud servers cannot reach private LAN addresses, and
   a central credential store is a target for state actors.
2. **Only events leave the device:** time, class, confidence, matched aircraft,
   approximate location, optionally embeddings. Audio clips upload only on
   explicit opt-in, and any clip containing speech is discarded first.
3. **The cloud only ever holds a revocable device token**, obtained with a
   pairing code. Onboarding happens locally on the agent.
4. **Exact sensor coordinates are private.** Public map shows approximate
   locations only, and must not reveal coverage gaps — those help an attacker.
   Public drone detections are delayed or coarsened.
5. **No public push alerts** without the Fire and Rescue Department and the
   military agreeing first. Verified detections on the map only.
6. **Never commit** `config.yaml`, `.env`, `*.wav`, or `*.jsonl`. They contain
   camera IPs, passwords, exact coordinates, and audio of private property.

## Ground truth via ADS-B

Sound events are matched to aircraft positions **at emission time**, not arrival
time: the aircraft moved during the `distance ÷ 343 m/s` travel delay, so
`matcher.emission_geometry` iterates to solve for it. Every aircraft passing
within `pass_radius_m` gets a heard / not-heard record — that is what yields
real detection range per aircraft type, and the labels for ML v0.2.

## Environment facts

- **System Python is 3.9.6, but the agent needs 3.10+** (`float | None` in
  `audio.py`). Use `agent/.venv` on 3.11/3.12 — see `agent/README.md`.
- **Docker is not installed on this Mac.** Builds and live runs happen on the
  Synology (Container Manager) or a Pi. Locally, test with `--replay` and pytest.
- `ffmpeg` / `ffprobe` are installed via Homebrew and work.
- Reolink camera at `192.168.1.88`, user `admin`, audio 16 kHz mono on
  `rtsp://.../Preview_01_sub`. Password lives in `agent/.env` only.
- **Chrome on macOS cannot reach the camera** (`ERR_ADDRESS_UNREACHABLE`) until
  Local Network permission is granted. `curl` and `ffmpeg` work regardless — so
  don't debug the camera through the browser.

## Conventions

- The detector is deliberately simple; it is the **data collector** the ML
  classifier gets trained on, not the final answer. Don't over-tune it.
- Keep credentials out of logs — `audio.redact()` exists for this, use it.
- Timestamps are `time.time()` at read and ignore RTSP latency (~0.5–2 s). Fine
  for aircraft matching; **not** good enough for multi-sensor trajectory
  estimation from arrival times. Fix before multilateration.
- Speed of sound is hardcoded 343 m/s in `geo.py`. Add temperature correction
  before trusting range figures.

## Commands
```bash
cd agent
python -m skyear.main --config config.yaml --data ./out --check      # camera + ADS-B
python -m skyear.main --config config.yaml --data ./out --replay rec.wav  # local, no ADS-B
pytest                                                                     # unit tests
docker compose run --rm skyear --check    # on the NAS: camera audio + ADS-B reachability
docker compose up -d && docker logs -f skyear-agent
```

# SkyEar

Security cameras already have microphones. SkyEar listens to them, and matches
what it hears against live aircraft positions — so every detection checks
itself. The first use case is aircraft around Vilnius airport, because ADS-B
labels them for free. The intended one is drones.

```
camera microphone ──► agent (your network) ──► events ──► map
                          │                      ▲
                          └── ADS-B ─────────────┘
                              ground truth
```

## What this is, honestly

Early, and measured rather than claimed. A single sensor near Vilnius hears a
minority of the aircraft that pass it, and wind regularly produces sounds loud
enough to be mistaken for one. The map publishes the detection rate next to the
share of time background noise is present, so a result can be judged rather than
trusted.

The most useful thing a sensor produces right now is **honest negatives**: every
aircraft that passes and is *not* heard is recorded too. That is what establishes
the real range of the method, and it is what a classifier will be trained on.

## Repository

```
agent/       Python edge agent. Runs in Docker on a NAS or Raspberry Pi.
web/         Next.js map and setup guide.
supabase/    Postgres schema, row-level security, Edge Functions.
```

## Run a sensor

Full walkthrough: [the setup guide](web/app/join/page.tsx) — or the hosted
version at `/join`.

```bash
# 1. Does your camera carry audio?
ffprobe -v error -rtsp_transport tcp \
  -show_entries stream=codec_type,codec_name,sample_rate -of compact \
  "rtsp://USER:PASSWORD@CAMERA-IP:554/Preview_01_sub"

# 2. Configure
cp agent/config.example.yaml agent/config.yaml   # camera, position, height
cp agent/.env.example agent/.env                 # camera password lives here only

# 3. Verify camera audio and ADS-B reachability
docker compose run --rm skyear --check

# 4. Pair with a code generated at /devices, then run
docker compose run --rm skyear --pair YOURCODE
docker compose up -d
```

The image is published for `linux/amd64` and `linux/arm64`, so the same tag runs
on a Synology and on a Raspberry Pi 4 or 5.

## What crosses your network boundary

**Sent:** when a sound started and how long it lasted, how loud it was against
the background, its frequency shape, which aircraft matched it, and a sensor
position rounded to about 110 metres.

**Never sent:** your camera's address, username or password; video; audio
recordings unless you opt in; your exact coordinates.

This is architectural rather than a promise. The agent runs inside your network
and pushes events out; nothing reaches in. No part of the site asks for a camera
address, because the servers could not use one — they cannot route to a private
address, and a credential store an operator can decrypt is worth attacking.

The privacy rules live in the database, not the interface: exact sensor
coordinates are readable only by their owner, the public view snaps them to a
~1 km grid, and drone detections are withheld for 30 minutes with their match
details stripped.

## Development

```bash
cd agent
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest          # 88 tests

.venv/bin/python -m skyear.main --config config.yaml --data ./out --replay rec.wav
```

```bash
cd web
cp .env.example .env.local
npm install && npm run dev
```

The agent needs Python 3.10+ syntax but carries `from __future__ import
annotations`, so a 3.9 environment works too — which matters, because NAS boxes
ship old Pythons. CI runs the suite on both.

## Not yet built

Speech detection before any clip upload, a local web UI for camera onboarding,
temperature correction for the speed of sound, and trajectory estimation from
multiple sensors — which needs timestamps better than the current ~0.5–2 s RTSP
latency.

SkyEar does not send alerts, and will not until the Fire and Rescue Department
and the military have had a say in how that should work.

## Licence

Apache 2.0.

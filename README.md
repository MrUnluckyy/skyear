# SkyEar

**Live: [skyear.lt](https://skyear.lt)**

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

**[Follow the setup guide](https://skyear.lt/join)** — it asks where you
are installing and shows only the steps for that. Nothing below is needed if you
use it.

No account is required to try this. The agent installs and tests your camera on
its own; you only sign in when you want the sensor on the map.

### Home Assistant

Add-on repository, separate so the Supervisor can read it:

```
https://github.com/MrUnluckyy/skyear-hassio
```

Settings → Add-ons → Add-on Store → ⋮ → Repositories → paste → Add. Refresh,
install **SkyEar**, start it, and open the panel that appears in the sidebar.
Ingress means there is no port to open and no address to find. Needs a 64-bit
system: there is no 32-bit ARM build, because numpy publishes no wheel for it.

### Docker, anywhere else

```bash
docker run -d --name skyear --restart unless-stopped --pull always \
  -p 8088:8088 -v skyear-data:/data ghcr.io/mrunluckyy/skyear-agent:latest
```

Then open `http://THAT-MACHINE:8088` and fill in one form: camera make, address,
password, position, and a pairing code from `/devices` when you want to connect.
The image is published for `linux/amd64` and `linux/arm64`, so the same tag runs
on a Synology, a Raspberry Pi 4 or 5, and an Intel box.

Your camera's address and password are written only to that machine. There is no
field anywhere on the website that asks for them.

### Config files

There is a `config.yaml`, and you do not need it. The setup page writes
everything into the agent's data directory instead, which is why the guide never
mentions it. It remains supported for unattended installs:

```bash
cp agent/config.example.yaml agent/config.yaml   # camera, position, height
cp agent/.env.example agent/.env                 # camera password lives here only
docker compose run --rm skyear --check           # camera audio + ADS-B reachability
docker compose run --rm skyear --pair YOURCODE
docker compose up -d
```

### More than one camera

Add them on the same setup page — a camera bar appears once there is more than
one. The agent tells the server which cameras it has on every upload, so a new
one registers itself; restart the agent after adding it so it starts listening.

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
.venv/bin/python -m pytest          # 153 tests

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

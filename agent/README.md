# SkyEar agent v0.1

Listens to camera microphones, detects sustained engine-like sounds, and links
each one to live ADS-B aircraft, correcting for sound travel time. Every
aircraft passing nearby gets a heard / not-heard record, which gives you real
detection range per aircraft type.

Nothing leaves the device except ADS-B API requests. Camera passwords stay in `.env`.

## Output (`./data`)
- `events.jsonl`: each sound event with SNR, dominant frequency, octave-band
  levels, and the closest matching aircraft (type, callsign, slant distance,
  altitude, bearing, delay)
- `passes.jsonl`: each aircraft that came within `pass_radius_m`, with closest
  distance and `heard: true/false`
- `clips/<camera>/*.wav`: audio of each event, for labelling and training

## Synology (DSM 7.2, Container Manager)
1. Create a folder such as `/volume1/docker/skyear` and copy this project there.
2. Copy `config.example.yaml` to `config.yaml` and set camera IP, lat/lon, and elevation.
3. Copy `.env.example` to `.env` and set `CAM1_PASSWORD`.
4. In Container Manager, go to Project, then Create. Set the path to that folder,
   choose "Use existing docker-compose.yml", and build.
5. Test first with an SSH session in the folder:
   `sudo docker compose run --rm skyear --check`
6. Watch the logs: `sudo docker logs -f skyear-agent`

Log lines look like this:
```
[home-1] HEARD 34s SNR 16.2 dB ~118 Hz -> BTI4TK BCS3 2.4 km, alt 760 m
[home-1] PASS RYR8KA B738 closest 5.9 km alt 2100 m -> not heard
```

## Replay a recording (no ADS-B)
`python -m skyear.main --config config.yaml --data ./out --replay rec.wav`

## Tuning
- Many short false events: raise `threshold_db` or `min_duration_s`.
- Aircraft reported "not heard" that you could hear yourself: lower `threshold_db` to 5–6.
- Check `floor_db` in events; lower means a quieter site.

## Raspberry Pi
The same image builds on arm64 (Pi 4/5, 64-bit OS). With an RTL-SDR dongle
running readsb, set `provider: readsb` for local, unlimited ADS-B data.

## Local development (macOS)

Docker is not installed on the dev Mac, so the local loop is venv + pytest +
`--replay`. Live runs happen on the Synology.

```bash
cd agent
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest                 # 40 tests, ~2 s
```

Replay a recording through the full pipeline (no ADS-B matching):
```bash
.venv/bin/python -m skyear.main --config config.example.yaml --data ./out --replay rec.wav
```

Make a synthetic aircraft pass to exercise the detector without a real recording:
see `tests/test_detector.py::engine` for the signal used by the test suite.

### Notes
- `skyear` needs Python 3.10+ syntax support only for annotations; the package
  carries `from __future__ import annotations`, so a 3.9 venv also works.
- In replay mode timestamps start at epoch 0, so `start_iso` and clip filenames
  read 1970. Harmless for tuning, but don't correlate replay output with real
  ADS-B data.
- `.env` is loaded automatically for local runs (`--env` to point elsewhere).
  Variables already in the environment win, so Docker Compose's `env_file`
  behaviour is unchanged.

## Pairing with the cloud

Set `cloud.url` in `config.yaml`, generate a code at `/devices` in the web app,
then on the machine with the camera:

```bash
.venv/bin/python -m skyear.main --config config.yaml --data ./out --pair ABCD2345
```

The code is single-use and expires in 15 minutes. On success the device token is
written to `out/device.json` (mode 0600) and the agent uploads on every run.

What actually crosses the network:
- **At pairing:** camera ids and a location rounded to ~110 m. Never an address,
  username, or password.
- **Afterwards:** event and pass records only. Clips stay on the device.

`events.jsonl` and `passes.jsonl` are the outbox. A byte offset in
`out/upload_state.json` is committed only after the server accepts a batch, so a
dropped connection replays rather than loses - and ingest is idempotent by
database constraint, so re-sending cannot duplicate rows.

To un-pair, delete `out/device.json` and revoke the device in the web app.

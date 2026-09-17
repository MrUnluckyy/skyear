from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import logging
import os
import signal
import threading
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import quote

import numpy as np
import yaml

from .adsb import AdsbTracker
from .audio import AudioSource, build_url
from .detector import BandEnergyDetector
from .matcher import PassTracker, match_event
from . import DEFAULT_CLOUD_URL, config_store
from .setup_server import serve as serve_setup
from .uploader import CloudError, Uploader, pair

log = logging.getLogger("skyear")

# What each camera is hearing right now, refreshed every audio chunk and read by
# the uploader. Single writer per key, so a plain dict is fine.
LIVE: dict[str, dict] = {}


class JsonlWriter:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path, self.lock = path, threading.Lock()

    def write(self, rec):
        with self.lock, open(self.path, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


class RingAudio:
    def __init__(self, sr, seconds):
        self.sr = sr
        self.chunks = collections.deque()
        self.max_s = seconds

    def add(self, t, x):
        self.chunks.append((t, (x * 32767).astype("<i2")))
        while self.chunks and self.chunks[-1][0] - self.chunks[0][0] > self.max_s:
            self.chunks.popleft()

    def slice(self, t0, t1):
        parts = [c for t, c in self.chunks if t + len(c) / self.sr >= t0 and t <= t1]
        return np.concatenate(parts) if parts else None


def load_env_file(path: Path):
    """Load KEY=VALUE lines from a .env file for local runs.

    Docker Compose already does this via `env_file:`, so anything already in the
    environment wins and this is a no-op in the container.
    """
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        if key:
            os.environ.setdefault(key, val)


def iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="seconds")


def camera_worker(cam, cfg, adsb, out_dir, events_w, passes_w, stop, live=True):
    cid = cam["id"]
    sensor = {"lat": cam["lat"], "lon": cam["lon"],
              "alt_m": cam.get("elevation_m", 0) + cam.get("mount_height_m", 0)}
    # For UniFi this is the stream token rather than a password; either way it
    # is the one secret that camera needs and it lives only in .env.
    secret_env = cam.get("url_env") or cam.get("password_env", "")
    password = os.environ.get(secret_env, "") if not cam.get("file") else ""
    if not cam.get("file") and not password and secret_env:
        log.error("[%s] env var %s is empty, skipping camera", cid, secret_env)
        return
    sr = 16000
    det = BandEnergyDetector(sr=sr, **cfg.get("detector", {}))
    clips_cfg = cfg.get("clips", {})
    pre = clips_cfg.get("pre_roll_s", 5)
    ring = RingAudio(sr, det.max_frames * det.frame_s + pre + 20)
    match_cfg = cfg.get("matching", {})
    max_range = match_cfg.get("max_range_m", 12000)

    pt = None
    if adsb and live:
        pt = PassTracker(adsb, sensor, match_cfg.get("pass_radius_m", 8000),
                         on_pass=lambda p: _on_pass(cid, p, passes_w),
                         max_fix_age_s=match_cfg.get("max_fix_age_s", 60),
                         track_ground=match_cfg.get("track_ground", False),
                         reopen_cooldown_s=match_cfg.get("reopen_cooldown_s", 120))

        def pass_loop():
            while not stop.is_set():
                try:
                    pt.tick()
                except Exception:
                    log.exception("[%s] pass tracker", cid)
                stop.wait(5)
        threading.Thread(target=pass_loop, daemon=True, name=f"pass-{cid}").start()

    src = AudioSource(build_url(cam, password), sr=sr, live=live)
    last_beat = 0.0
    for t, x in src.chunks():
        if stop.is_set():
            src.stop()
            break
        ring.add(t, x)
        state = det.state()
        state["at"] = time.time()
        LIVE[cid] = state
        for ev in det.process(t, x):
            ev["id"] = uuid.uuid4().hex[:12]
            ev["camera"] = cid
            ev["start_iso"] = iso(ev["start"])
            cands = (match_event(adsb, sensor, ev, max_range,
                                 max_fix_age_s=match_cfg.get("max_fix_age_s", 60),
                                 track_ground=match_cfg.get("track_ground", False))
                     if (adsb and live) else [])
            ev["aircraft"] = cands
            best = cands[0] if cands else None
            if clips_cfg.get("save", True):
                audio = ring.slice(ev["start"] - pre, ev["end"] + 2)
                if audio is not None:
                    p = out_dir / "clips" / cid / f"{dt.datetime.fromtimestamp(ev['start']):%Y%m%d_%H%M%S}_{ev['id']}.wav"
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with wave.open(str(p), "wb") as w:
                        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
                        w.writeframes(audio.tobytes())
                    ev["clip"] = str(p.relative_to(out_dir))
            events_w.write(ev)
            # Wind is still written and clipped - it is training data for a
            # future noise class - but it must never mark an aircraft as heard,
            # or the detection rate this project is judged on becomes fiction.
            if pt and not ev.get("likely_wind"):
                pt.add_event(ev, best["hex"] if best else None)
            what = (f"{best.get('flight') or best['hex']} {best.get('type') or '?'} "
                    f"{best['slant_m']/1000:.1f} km, alt {best['alt_m']} m") if best else "no aircraft match"
            log.info("[%s] %s %.0fs SNR %.1f dB ~%.0f Hz tilt %.0f dB -> %s",
                     cid, "WIND " if ev.get("likely_wind") else "HEARD",
                     ev["duration_s"], ev["snr_db"], ev["dominant_hz"],
                     ev["low_tilt_db"], what)
        if live and time.time() - last_beat > 60 and det.floor is not None:
            log.info("[%s] alive, noise floor %.1f dB", cid, det.floor)
            last_beat = time.time()


def _on_pass(cid, p, w):
    p["camera"] = cid
    p["closest_iso"] = iso(p["closest_time"])
    w.write(p)
    log.info("[%s] PASS %s %s closest %.1f km alt %d m -> %s", cid, p.get("flight") or p["hex"],
             p.get("type") or "?", p["min_slant_m"] / 1000, p["alt_m"], "HEARD" if p["heard"] else "not heard")


def cleanup_loop(out_dir, keep_days, stop):
    while not stop.is_set():
        cutoff = time.time() - keep_days * 86400
        for f in (out_dir / "clips").rglob("*.wav"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass
        stop.wait(3600)


def _scrub(text: str, secret: str) -> str:
    """Strip a camera password out of ffprobe output before it reaches a log.

    ffmpeg echoes the whole RTSP URL on failure, credentials included, and
    build_url percent-encodes the password, so both forms are replaced.
    """
    if not secret:
        return text
    return text.replace(quote(secret, safe=""), "***").replace(secret, "***")


def device_file(out_dir: Path) -> Path:
    """Where the device token lives. Inside the data dir, which is gitignored."""
    return out_dir / "device.json"


def make_uploader(cfg, out_dir: Path):
    """Build an Uploader if this agent has been paired, else None."""
    cloud = cfg.get("cloud", {})
    url = cloud.get("url") or DEFAULT_CLOUD_URL
    path = device_file(out_dir)
    if not path.is_file():
        log.warning("cloud.url is set but this agent is not paired yet - run --pair CODE")
        return None
    try:
        token = json.loads(path.read_text())["token"]
    except (OSError, json.JSONDecodeError, KeyError):
        log.error("%s is unreadable; re-pair with --pair CODE", path)
        return None
    return Uploader(url, token, out_dir, interval_s=cloud.get("upload_interval_s", 10),
                    live=LIVE)


def run_pair(cfg, cams, out_dir: Path, code: str):
    cloud = cfg.get("cloud", {})
    url = cloud.get("url") or DEFAULT_CLOUD_URL
    path = device_file(out_dir)
    if path.is_file():
        print(f"FAIL already paired ({path}). Delete that file to pair again.")
        return 1
    try:
        res = pair(url, code, cams, name=cloud.get("device_name", "SkyEar agent"))
    except CloudError as e:
        print(f"FAIL {e}")
        return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(res, indent=1))
    path.chmod(0o600)  # the token is a credential
    print(f"OK paired as device {res['device_id']}")
    print(f"   cameras: {', '.join(res.get('cameras', []))}")
    print(f"   token stored in {path} (never commit it)")
    return 0


def run_check(cfg, cams, a):
    import subprocess
    ok = True
    for c in cams:
        secret_env = c.get("url_env") or c.get("password_env", "")
        pw = os.environ.get(secret_env, "")
        if secret_env and not pw:
            print(f"[{c['id']}] FAIL {secret_env} is not set "
                  f"(put it in .env, or export it before running)")
            ok = False
            continue
        url = build_url(c, pw)
        r = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-timeout", "10000000",
                            "-show_entries", "stream=codec_type,codec_name,sample_rate", "-of", "compact", url],
                           capture_output=True, text=True, timeout=30)
        audio = "codec_type=audio" in r.stdout
        ok &= audio
        detail = (r.stdout.strip() if audio
                  else _scrub(r.stderr.strip() or r.stdout.strip() or "no audio stream", pw))
        print(f"[{c['id']}] {'OK audio: ' + detail if audio else 'FAIL ' + detail}")
    t = AdsbTracker(a.get("provider", "adsb.lol"), a.get("lat", cams[0]["lat"]), a.get("lon", cams[0]["lon"]),
                    a.get("radius_nm", 15), readsb_url=a.get("readsb_url"))
    try:
        t.poll_once()
        snap = t.snapshot()
        print(f"[adsb] OK {len(snap)} aircraft within {t.radius_nm} nm")
        for hx, (m, (_, lat, lon, alt)) in list(snap.items())[:10]:
            print(f"   {m.get('flight') or hx:9} {m.get('type') or '?':5} alt {alt:6.0f} m")
    except Exception as e:
        ok = False
        print(f"[adsb] FAIL {e}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="SkyEar agent")
    ap.add_argument("--config", default=os.environ.get("SKYEAR_CONFIG", "/config/config.yaml"))
    ap.add_argument("--data", default=os.environ.get("SKYEAR_DATA", "/data"))
    ap.add_argument("--check", action="store_true", help="test camera audio and ADS-B, then exit")
    ap.add_argument("--replay", help="analyse a local audio file instead of cameras (no ADS-B matching)")
    ap.add_argument("--env", default=os.environ.get("SKYEAR_ENV", ".env"),
                    help="file to read camera passwords from (default: .env)")
    ap.add_argument("--setup-port", type=int, default=int(os.environ.get("SKYEAR_SETUP_PORT", 8088)),
                    help="port for the local setup page (default: 8088)")
    ap.add_argument("--no-setup", action="store_true", help="do not serve the setup page")
    ap.add_argument("--pair", metavar="CODE",
                    help="pair this agent with an account using a code from the web app")
    args = ap.parse_args()
    load_env_file(Path(args.env))

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    out_dir = Path(args.data)
    # config.yaml is now optional. It still wins where present, so existing
    # installs are untouched, but a fresh agent can be configured entirely from
    # the setup page instead of a text editor.
    cfg = {}
    if Path(args.config).is_file():
        cfg = yaml.safe_load(open(args.config)) or {}
    stored = config_store.load(out_dir)
    cfg = config_store.to_agent_config(stored, cfg)
    # Camera secrets written by the setup page behave exactly like .env entries.
    for name, value in config_store.secrets_from(stored).items():
        os.environ.setdefault(name, value)
    events_w = JsonlWriter(out_dir / "events.jsonl")
    passes_w = JsonlWriter(out_dir / "passes.jsonl")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    if args.replay:
        cam = {"id": "replay", "file": args.replay, "lat": 0, "lon": 0}
        camera_worker(cam, cfg, None, out_dir, events_w, passes_w, stop, live=False)
        return

    a = cfg.get("adsb", {})
    cams = cfg.get("cameras") or []
    if args.pair:
        return run_pair(cfg, cams, out_dir, args.pair)
    if args.check:
        return run_check(cfg, cams, a)
    if not args.no_setup:
        try:
            serve_setup(out_dir, LIVE, port=args.setup_port)
        except OSError as e:
            log.warning("setup page unavailable on port %d: %s", args.setup_port, e)

    if not cams:
        log.warning("no camera configured yet - open the setup page above to add one")
        while not stop.is_set():
            stop.wait(1)
        return 0

    adsb = AdsbTracker(a.get("provider", "adsb.lol"), a.get("lat", cams[0]["lat"]), a.get("lon", cams[0]["lon"]),
                       a.get("radius_nm", 15), a.get("poll_seconds", 5), a.get("readsb_url"),
                       max_backoff_s=a.get("max_backoff_s", 300))
    threading.Thread(target=adsb.run, args=(stop,), daemon=True, name="adsb").start()
    threading.Thread(target=cleanup_loop, args=(out_dir, cfg.get("clips", {}).get("keep_days", 14), stop),
                     daemon=True, name="cleanup").start()
    uploader = make_uploader(cfg, out_dir)
    if uploader:
        threading.Thread(target=uploader.run, args=(stop,), daemon=True, name="upload").start()
        log.info("cloud upload enabled")

    threads = [threading.Thread(target=camera_worker, args=(c, cfg, adsb, out_dir, events_w, passes_w, stop),
                                daemon=True, name=f"cam-{c['id']}") for c in cams]
    for th in threads:
        th.start()
    log.info("SkyEar agent running with %d camera(s)", len(threads))
    while not stop.is_set():
        stop.wait(1)
    log.info("stopping")


if __name__ == "__main__":
    raise SystemExit(main())

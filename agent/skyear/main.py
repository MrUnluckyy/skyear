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

import numpy as np
import yaml

from .adsb import AdsbTracker
from .audio import AudioSource, build_url
from .detector import BandEnergyDetector
from .matcher import PassTracker, match_event

log = logging.getLogger("skyear")


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


def iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="seconds")


def camera_worker(cam, cfg, adsb, out_dir, events_w, passes_w, stop, live=True):
    cid = cam["id"]
    sensor = {"lat": cam["lat"], "lon": cam["lon"],
              "alt_m": cam.get("elevation_m", 0) + cam.get("mount_height_m", 0)}
    password = os.environ.get(cam.get("password_env", ""), "") if not cam.get("file") else ""
    if not cam.get("file") and not password and cam.get("password_env"):
        log.error("[%s] env var %s is empty, skipping camera", cid, cam.get("password_env"))
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
                         on_pass=lambda p: _on_pass(cid, p, passes_w))

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
        for ev in det.process(t, x):
            ev["id"] = uuid.uuid4().hex[:12]
            ev["camera"] = cid
            ev["start_iso"] = iso(ev["start"])
            cands = match_event(adsb, sensor, ev, max_range) if (adsb and live) else []
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
            if pt:
                pt.add_event(ev, best["hex"] if best else None)
            what = (f"{best.get('flight') or best['hex']} {best.get('type') or '?'} "
                    f"{best['slant_m']/1000:.1f} km, alt {best['alt_m']} m") if best else "no aircraft match"
            log.info("[%s] HEARD %.0fs SNR %.1f dB ~%.0f Hz -> %s",
                     cid, ev["duration_s"], ev["snr_db"], ev["dominant_hz"], what)
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


def run_check(cfg, cams, a):
    import subprocess
    ok = True
    for c in cams:
        pw = os.environ.get(c.get("password_env", ""), "")
        url = build_url(c, pw)
        r = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-timeout", "10000000",
                            "-show_entries", "stream=codec_type,codec_name,sample_rate", "-of", "compact", url],
                           capture_output=True, text=True, timeout=30)
        audio = "codec_type=audio" in r.stdout
        ok &= audio
        print(f"[{c['id']}] {'OK audio: ' + r.stdout.strip() if audio else 'FAIL ' + (r.stderr.strip() or r.stdout.strip() or 'no audio stream')}")
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
    args = ap.parse_args()

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = yaml.safe_load(open(args.config))
    out_dir = Path(args.data)
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
    cams = cfg["cameras"]
    if args.check:
        return run_check(cfg, cams, a)
    adsb = AdsbTracker(a.get("provider", "adsb.lol"), a.get("lat", cams[0]["lat"]), a.get("lon", cams[0]["lon"]),
                       a.get("radius_nm", 15), a.get("poll_seconds", 5), a.get("readsb_url"))
    threading.Thread(target=adsb.run, args=(stop,), daemon=True, name="adsb").start()
    threading.Thread(target=cleanup_loop, args=(out_dir, cfg.get("clips", {}).get("keep_days", 14), stop),
                     daemon=True, name="cleanup").start()
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

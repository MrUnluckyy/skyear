"""A setup page served by the agent itself.

Replaces the parts of installation that need a terminal: editing YAML, finding
coordinates, looking up ground elevation, writing a password into .env, and
running a pairing command. It answers the question nobody could answer before
walking away - is the microphone actually working - with a live level meter.

Deliberately stdlib only. The agent's whole dependency list is numpy and PyYAML
and it runs on NAS boxes with old Pythons; a web framework here would cost more
than it is worth.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__, config_store
from .audio import build_url, redact
from .uploader import CloudError, coarse, pair

log = logging.getLogger("setup")

ELEVATION_API = "https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}"


def probe_camera(cam: dict, secret: str, timeout: int = 25) -> dict:
    """Ask ffprobe what the camera streams. Never echoes the credential back."""
    url = build_url(cam, secret)
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-timeout", "10000000",
             "-show_entries", "stream=codec_type,codec_name,sample_rate",
             "-of", "json", url],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "The camera did not respond in time."}
    except FileNotFoundError:
        return {"ok": False, "error": "ffprobe is not installed on this machine."}

    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        detail = err[-1] if err else "unknown error"
        # Translate the two failures people actually hit.
        low = detail.lower()
        if "401" in low or "unauthorized" in low:
            detail = "The camera rejected that username or password."
        elif "timed out" in low or "refused" in low:
            detail = "Could not reach the camera. Check the address, and that RTSP is enabled."
        return {"ok": False, "error": redact(detail)}

    try:
        streams = json.loads(r.stdout).get("streams", [])
    except json.JSONDecodeError:
        return {"ok": False, "error": "The camera replied with something unexpected."}

    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio:
        return {"ok": False,
                "error": "This camera streams video but no audio, so it cannot be a sensor."}
    return {
        "ok": True,
        "codec": audio.get("codec_name"),
        "sample_rate": int(audio.get("sample_rate") or 0),
        "video": any(s.get("codec_type") == "video" for s in streams),
    }


def lookup_elevation(lat: float, lon: float) -> float | None:
    """Ground height above sea level, so nobody has to know it."""
    try:
        req = urllib.request.Request(
            ELEVATION_API.format(lat=f"{lat:.5f}", lon=f"{lon:.5f}"),
            headers={"user-agent": f"skyear-agent/{__version__}"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return float(json.load(r)["elevation"][0])
    except Exception as e:
        log.warning("elevation lookup failed: %s", e)
        return None


class SetupHandler(BaseHTTPRequestHandler):
    server_version = f"skyear/{__version__}"
    data_dir: Path
    live: dict
    page: str

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    # --- helpers ---------------------------------------------------------
    def _send(self, body: bytes, ctype: str, status: int = 200):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        # No external resources, no framing, no referrer leakage.
        self.send_header("content-security-policy",
                         "default-src 'none'; style-src 'unsafe-inline'; "
                         "script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:")
        self.send_header("referrer-policy", "no-referrer")
        self.send_header("x-frame-options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(json.dumps(obj).encode(), "application/json", status)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return {}

    def _authorised(self) -> bool:
        """Open until a camera is saved, then a token is required.

        A brand-new agent has nothing worth protecting and demanding a token
        from a log file would defeat the purpose of a setup page. Once a camera
        password is stored, that stops being true.
        """
        if not config_store.is_configured(self.data_dir):
            return True
        want = config_store.setup_token(self.data_dir)
        got = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("t", [""])[0]
        return got == want

    # --- routes ----------------------------------------------------------
    def do_GET(self):
        route = urllib.parse.urlparse(self.path).path
        if route in ("/", "/index.html"):
            return self._send(self.page.encode(), "text/html; charset=utf-8")
        if not self._authorised():
            return self._json({"error": "setup is locked on this agent"}, 403)
        if route == "/api/state":
            stored = config_store.load(self.data_dir)
            cams = stored.get("cameras", [])
            return self._json({
                "version": __version__,
                "configured": bool(cams),
                "paired": (self.data_dir / "device.json").is_file(),
                "cameras": [{k: v for k, v in c.items() if k != "password"} for c in cams],
                "cloud_url": (stored.get("cloud") or {}).get("url", ""),
                "live": self.live,
            })
        if route == "/api/level":
            return self._json({"live": self.live})
        if route == "/api/elevation":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                lat, lon = float(q["lat"][0]), float(q["lon"][0])
            except (KeyError, ValueError):
                return self._json({"error": "lat and lon required"}, 400)
            return self._json({"elevation_m": lookup_elevation(lat, lon)})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if not self._authorised():
            return self._json({"error": "setup is locked on this agent"}, 403)
        body = self._body()

        if route == "/api/test":
            cam = body.get("camera") or {}
            return self._json(probe_camera(cam, body.get("secret", "")))

        if route == "/api/save":
            cam = body.get("camera") or {}
            secret = body.get("secret", "")
            if not cam.get("id") or cam.get("lat") is None or cam.get("lon") is None:
                return self._json({"error": "camera id and position are required"}, 400)
            env_name = f"{cam['id'].upper().replace('-', '_')}_SECRET"
            if cam.get("type") == "ubiquiti" or cam.get("url_env"):
                cam["password_env"] = env_name
            else:
                cam["password_env"] = env_name
            stored = config_store.load(self.data_dir)
            others = [c for c in stored.get("cameras", []) if c["id"] != cam["id"]]
            stored["cameras"] = others + [cam]
            stored.setdefault("secrets", {})[env_name] = secret
            if body.get("cloud_url"):
                stored.setdefault("cloud", {})["url"] = body["cloud_url"]
            config_store.save(self.data_dir, stored)
            return self._json({"ok": True, "restart_required": True,
                               "setup_token": config_store.setup_token(self.data_dir)})

        if route == "/api/pair":
            stored = config_store.load(self.data_dir)
            url = body.get("cloud_url") or (stored.get("cloud") or {}).get("url")
            cams = stored.get("cameras", [])
            if not url:
                return self._json({"error": "no cloud url configured"}, 400)
            if not cams:
                return self._json({"error": "add a camera first"}, 400)
            if (self.data_dir / "device.json").is_file():
                return self._json({"error": "this agent is already paired"}, 400)
            try:
                res = pair(url, body.get("code", ""), cams,
                           name=body.get("name") or "SkyEar agent")
            except CloudError as e:
                return self._json({"error": str(e)}, 400)
            p = self.data_dir / "device.json"
            p.write_text(json.dumps(res, indent=1))
            p.chmod(0o600)
            return self._json({"ok": True, "device_id": res.get("device_id")})

        return self._json({"error": "not found"}, 404)


def serve(data_dir: Path, live: dict, port: int = 8088, host: str = "0.0.0.0") -> ThreadingHTTPServer:
    page = (Path(__file__).parent / "setup.html").read_text()
    handler = type("Bound", (SetupHandler,),
                   {"data_dir": Path(data_dir), "live": live, "page": page})
    httpd = ThreadingHTTPServer((host, port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="setup").start()
    log.info("setup page on http://<this-machine>:%d", port)
    return httpd

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

from . import DEFAULT_CLOUD_URL, __version__, config_store
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
    def _send(self, body: bytes, ctype: str, status: int = 200, cookie: str | None = None):
        self.send_response(status)
        self.send_header("content-type", ctype)
        if cookie:
            # Host-only, not readable by script, and not sent cross-site. It is
            # a LAN setup page, so Secure would break it over plain http.
            self.send_header("set-cookie",
                             f"skyear_setup={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
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

    def _json(self, obj, status=200, cookie=None):
        self._send(json.dumps(obj).encode(), "application/json", status, cookie=cookie)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return {}

    def _cookie_token(self) -> str:
        raw = self.headers.get("cookie") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "skyear_setup":
                return value
        return ""

    def _authorised(self) -> bool:
        """Open until a camera is saved, then a token is required.

        A brand-new agent has nothing worth protecting, and demanding a token
        from a log file would defeat the purpose of a setup page. Once a camera
        password is stored, that stops being true.

        The token is accepted from a cookie as well as the query string, and
        saving sets that cookie. Without it, pressing Save locked the person
        who just configured the agent out of their own setup page, with the
        recovery buried in a file inside the container.
        """
        if not config_store.is_configured(self.data_dir):
            return True
        want = config_store.setup_token(self.data_dir)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("t", [""])[0]
        return want in (query, self._cookie_token())

    def handle_one_request(self):
        """Never let an exception kill the connection.

        BaseHTTPRequestHandler drops the socket when a handler raises, which
        reaches the caller as a bare 502 through Home Assistant's ingress proxy
        and says nothing about what broke. Turning it into a JSON 500 with the
        exception text means the setup page can show the real fault.
        """
        try:
            super().handle_one_request()
        except Exception as e:
            log.exception("unhandled error serving %s", self.path)
            try:
                self._json({"error": f"The agent failed handling this request: "
                                     f"{type(e).__name__}: {e}"}, 500)
            except Exception:
                pass

    # --- routes ----------------------------------------------------------
    def do_GET(self):
        """Reads are open; only changes need the token.

        Nothing readable here is a secret - the camera password is never
        returned, and the rest is whether a camera is configured and what it is
        hearing. Locking reads only managed to lock people out of their own
        setup page while protecting nothing.
        """
        route = urllib.parse.urlparse(self.path).path
        if route in ("/", "/index.html"):
            return self._send(self.page.encode(), "text/html; charset=utf-8")
        if route == "/api/state":
            stored = config_store.load(self.data_dir)
            cams = stored.get("cameras", [])
            return self._json({
                "version": __version__,
                "configured": bool(cams),
                "paired": (self.data_dir / "device.json").is_file(),
                "cameras": [{k: v for k, v in c.items() if k != "password"} for c in cams],
                "cloud_url": (stored.get("cloud") or {}).get("url") or DEFAULT_CLOUD_URL,
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
        try:
            self._post()
        except Exception as e:
            log.exception("error in %s", self.path)
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def _post(self):
        route = urllib.parse.urlparse(self.path).path
        if not self._authorised():
            return self._json({
                "error": "This agent is already configured, so setup is locked to the "
                         "browser that set it up. To unlock another browser, open this page "
                         "with ?t= followed by the token in data/setup_token "
                         "(in Docker: docker exec skyear cat /data/setup_token).",
            }, 403)
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
            token = config_store.setup_token(self.data_dir)
            return self._json({"ok": True, "restart_required": True, "setup_token": token},
                              cookie=token)

        if route == "/api/pair":
            stored = config_store.load(self.data_dir)
            url = (body.get("cloud_url") or (stored.get("cloud") or {}).get("url")
                   or DEFAULT_CLOUD_URL)
            cams = stored.get("cameras", [])
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


def lan_address() -> str | None:
    """This machine's address on the local network.

    Opening a UDP socket toward a public address reveals which local interface
    the OS would route through, without sending anything. Inside Docker with
    bridge networking this reports the container address rather than the host,
    which is why the log says so and the guide tells people to use their NAS
    address instead.
    """
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def serve(data_dir: Path, live: dict, port: int = 8088, host: str = "0.0.0.0") -> ThreadingHTTPServer:
    page = (Path(__file__).parent / "setup.html").read_text()
    handler = type("Bound", (SetupHandler,),
                   {"data_dir": Path(data_dir), "live": live, "page": page})
    httpd = ThreadingHTTPServer((host, port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="setup").start()
    ip = lan_address()
    log.info("setup page: http://%s:%d", ip or "<this-machine>", port)
    if ip and ip.startswith("172."):
        log.info("  (that is the container's address - use this machine's own, with :%d)", port)
    return httpd

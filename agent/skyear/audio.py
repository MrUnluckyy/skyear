"""Reads mono PCM from an RTSP camera (or a file) through ffmpeg."""
from __future__ import annotations
import logging
import re
import subprocess
import time
from urllib.parse import quote

import numpy as np

log = logging.getLogger("audio")

STREAM_PATHS = {
    # type: (main, sub)
    "reolink": ("/Preview_{ch:02d}_main", "/Preview_{ch:02d}_sub"),
    "hikvision": ("/Streaming/Channels/{ch}01", "/Streaming/Channels/{ch}02"),
    "dahua": ("/cam/realmonitor?channel={ch}&subtype=0", "/cam/realmonitor?channel={ch}&subtype=1"),
}


# UniFi Protect works unlike every other brand here: the stream comes from the
# NVR rather than the camera, over RTSPS on 7441, and there is no username or
# password - a per-camera token in the path IS the credential. It is generated
# by Protect and cannot be derived, so it has to be read from the UI and, being
# a secret, it belongs in .env rather than config.yaml.
UBIQUITI_PORT = 7441


def build_url(cam: dict, secret: str) -> str:
    """Build the stream URL. `secret` is the camera password, or for UniFi the
    stream token, whichever that camera type uses."""
    if cam.get("file"):
        return cam["file"]

    # A full URL supplied wholesale, for anything the builders cannot express.
    if cam.get("url_env"):
        return secret

    ctype = cam.get("type", "reolink")
    ch = int(cam.get("channel", 1))

    if ctype == "ubiquiti":
        port = cam.get("port", UBIQUITI_PORT)
        # enableSrtp is required by Protect; without it the stream is refused.
        return f"rtsps://{cam['host']}:{port}/{secret}?enableSrtp"

    if ctype == "generic":
        path = cam["path"]
    else:
        main, sub = STREAM_PATHS[ctype]
        path = (sub if cam.get("stream", "sub") == "sub" else main).format(ch=ch)
    user = quote(cam.get("username", "admin"), safe="")
    pw = quote(secret, safe="")
    port = cam.get("port", 554)
    return f"rtsp://{user}:{pw}@{cam['host']}:{port}{path}"


def redact(url: str) -> str:
    """Strip credentials before a URL reaches a log.

    Two shapes carry secrets: the usual user:pass@host, and UniFi's rtsps URL
    where the path token is itself the credential. Masking only the first would
    have printed a working stream key into the log file.
    """
    if "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    if "@" in rest:
        return f"{scheme}://***@{rest.split('@', 1)[1]}"
    if scheme == "rtsps" and "/" in rest:
        host = rest.split("/", 1)[0]
        return f"{scheme}://{host}/***"
    return url


# Any scheme://userinfo@host, anywhere in a blob of text.
_CREDENTIAL_IN_TEXT = re.compile(r"(\w+://)([^/\s@]+)@")


def url_secret(url: str) -> str:
    """The part of a URL that is the credential, if there is one."""
    if "://" not in url:
        return ""
    scheme, rest = url.split("://", 1)
    if "@" in rest:
        userinfo = rest.split("@", 1)[0]
        return userinfo.split(":", 1)[1] if ":" in userinfo else ""
    if scheme == "rtsps" and "/" in rest:
        # UniFi: the path token is itself the credential.
        return rest.split("/", 1)[1].split("?", 1)[0]
    return ""


def redact_text(text: str, url: str = "") -> str:
    """Strip credentials out of arbitrary text, not just a bare URL.

    redact() takes a URL we constructed. This takes ffmpeg's stderr, which is
    prose with a URL buried in it - and ffmpeg prints the URL in full,
    credentials included, on every failure. Passing that straight to the log
    wrote the camera password into out/agent.log once per reconnect:

        Error opening input file rtsp://admin:hunter2@192.168.1.88:554/...

    The file is gitignored so nothing reached the repo, but a log is the thing
    people paste into a forum post or hand over when asking for help, and on
    Home Assistant the add-on log is visible in the UI.

    `url` is optional and only needed for the rtsps path-token form, which has
    no '@' for the pattern to key on.
    """
    out = _CREDENTIAL_IN_TEXT.sub(r"\1***@", text)
    secret = url_secret(url) if url else ""
    if secret:
        # Both the raw form and the percent-encoded one build_url produces.
        out = out.replace(quote(secret, safe=""), "***").replace(secret, "***")
    return out


class AudioSource:
    """Yields (t_start_unix, float32 samples) chunks. Reconnects forever for live streams."""

    def __init__(self, url: str, sr: int = 16000, chunk_s: float = 0.25, live: bool = True):
        self.url, self.sr, self.live = url, sr, live
        self.chunk_bytes = int(sr * chunk_s) * 2
        self._stop = False

    def stop(self):
        self._stop = True

    def _cmd(self):
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
        if self.url.startswith("rtsp"):
            cmd += ["-rtsp_transport", "tcp", "-timeout", "10000000"]
        cmd += ["-i", self.url, "-vn", "-ac", "1", "-ar", str(self.sr), "-f", "s16le", "-"]
        return cmd

    def chunks(self, file_t0: float | None = None):
        backoff = 2
        while not self._stop:
            log.info("connecting %s", redact(self.url))
            proc = subprocess.Popen(self._cmd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            n = 0
            t0 = None
            try:
                while not self._stop:
                    buf = proc.stdout.read(self.chunk_bytes)
                    if not buf:
                        break
                    if t0 is None:
                        t0 = time.time() if self.live else (file_t0 or 0.0)
                        backoff = 2
                        log.info("audio flowing from %s", redact(self.url))
                    x = np.frombuffer(buf[: len(buf) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
                    t = t0 + n / self.sr
                    drift = t - time.time()
                    if self.live and abs(drift) > 3.0:
                        # The audio timeline has come loose from the clock -
                        # a stalled stream, a backlog dumped at once, or the
                        # process being suspended. Re-anchor to now, because a
                        # stale timestamp silently breaks ADS-B matching: the
                        # aircraft track history no longer covers it and every
                        # detection comes back unexplained.
                        if abs(drift) > 60:
                            log.warning("audio clock was %.0f s from wall time, re-anchoring",
                                        drift)
                        t0 = time.time() - n / self.sr
                        t = t0 + n / self.sr
                    n += len(x)
                    yield t, x
            finally:
                proc.kill()
                err = proc.stderr.read().decode(errors="ignore").strip()
                proc.wait()
            # Redact before truncating. Slicing first can cut through a URL so
            # the pattern no longer matches, while a fragment of the password
            # survives into the log.
            safe = redact_text(err, self.url) if err else ""
            if not self.live:
                if safe:
                    log.error("ffmpeg: %s", safe[-500:])
                return
            log.warning("stream ended (%s), retry in %ss", safe[-200:] or "no error", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

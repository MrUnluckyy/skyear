"""Reads mono PCM from an RTSP camera (or a file) through ffmpeg."""
from __future__ import annotations
import logging
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


def build_url(cam: dict, password: str) -> str:
    if cam.get("file"):
        return cam["file"]
    ctype = cam.get("type", "reolink")
    ch = int(cam.get("channel", 1))
    if ctype == "generic":
        path = cam["path"]
    else:
        main, sub = STREAM_PATHS[ctype]
        path = (sub if cam.get("stream", "sub") == "sub" else main).format(ch=ch)
    user = quote(cam.get("username", "admin"), safe="")
    pw = quote(password, safe="")
    port = cam.get("port", 554)
    return f"rtsp://{user}:{pw}@{cam['host']}:{port}{path}"


def redact(url: str) -> str:
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        return f"{scheme}://***@{rest.split('@', 1)[1]}"
    return url


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
                    if self.live and abs(t - time.time()) > 3.0:  # re-anchor on drift/stall
                        t0, n = time.time() - n / self.sr, n
                        t = t0 + n / self.sr
                    n += len(x)
                    yield t, x
            finally:
                proc.kill()
                err = proc.stderr.read().decode(errors="ignore").strip()
                proc.wait()
            if not self.live:
                if err:
                    log.error("ffmpeg: %s", err[-500:])
                return
            log.warning("stream ended (%s), retry in %ss", err[-200:] or "no error", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

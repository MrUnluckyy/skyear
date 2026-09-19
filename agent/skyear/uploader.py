"""Ship events and passes to the cloud, and pair this agent with an account.

The JSONL files are the outbox. Progress is a byte offset committed only after
the server has accepted a batch, so a dropped connection replays the batch
rather than losing it - ingest is idempotent by database constraint, so
re-sending is safe.

Nothing here ever reads camera credentials. The location sent at pairing time is
deliberately coarsened: the cloud has no use for a precise sensor position and
should not hold one (invariant 3 in CLAUDE.md).
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__

log = logging.getLogger("uploader")

BATCH = 200
LOCATION_DP = 3  # ~110 m; the finest position the cloud is ever told


class CloudError(Exception):
    """Raised when the server refuses a request for a non-transient reason."""


def _error_body(exc: urllib.error.HTTPError, limit: int = 200) -> str:
    """Read an error response defensively.

    An HTTPError does not always carry a readable body, and letting .read()
    raise inside an exception handler would kill the uploader thread.
    """
    try:
        return exc.read().decode(errors="ignore")[:limit]
    except Exception:
        return exc.reason if isinstance(getattr(exc, "reason", None), str) else ""


def _post(url: str, payload: dict, token: str | None = None, timeout: float = 20.0) -> dict:
    body = json.dumps(payload).encode()
    headers = {"content-type": "application/json", "user-agent": f"skyear-agent/{__version__}"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def coarse(value: float) -> float:
    """Round a coordinate to the precision the cloud is allowed to know."""
    return round(value, LOCATION_DP)


def pair(base_url: str, code: str, cameras: list[dict], name: str = "SkyEar agent") -> dict:
    """Trade a pairing code for a device token. Returns the server response."""
    payload = {
        "code": code.strip().upper(),
        "name": name,
        "agent_version": __version__,
        "cameras": [
            {
                "camera_id": c["id"],
                "lat": coarse(float(c["lat"])),
                "lon": coarse(float(c["lon"])),
                "elevation_m": float(c.get("elevation_m", 0)),
                "mount_height_m": float(c.get("mount_height_m", 0)),
            }
            for c in cameras
        ],
    }
    try:
        return _post(f"{base_url.rstrip('/')}/functions/v1/pair", payload)
    except urllib.error.HTTPError as e:
        raise CloudError(f"pairing failed ({e.code}): {_error_body(e, 500)}") from None


class Outbox:
    """A JSONL file read forward from a committed byte offset."""

    def __init__(self, path: Path, offset: int = 0):
        self.path = path
        self.offset = offset

    def read_batch(self, limit: int = BATCH) -> tuple[list[dict], int]:
        """Return (records, new_offset). Partial trailing lines are left alone."""
        if not self.path.is_file():
            return [], self.offset
        size = self.path.stat().st_size
        if size < self.offset:  # file truncated or rotated
            log.warning("%s shrank, restarting from 0", self.path.name)
            self.offset = 0
        if size == self.offset:
            return [], self.offset

        records, consumed = [], self.offset
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            for raw in f:
                if not raw.endswith(b"\n"):
                    break  # still being written; pick it up next time
                consumed += len(raw)
                line = raw.decode(errors="replace").strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        log.warning("skipping malformed line in %s", self.path.name)
                if len(records) >= limit:
                    break
        return records, consumed


class Uploader:
    def __init__(self, base_url: str, token: str, data_dir: Path,
                 interval_s: float = 10.0, max_backoff_s: float = 600.0,
                 live: dict | None = None, cameras: list[dict] | None = None):
        self.url = f"{base_url.rstrip('/')}/functions/v1/ingest"
        self.token = token
        self.state_path = data_dir / "upload_state.json"
        self.interval_s = interval_s
        self.max_backoff_s = max_backoff_s
        # Live per-camera state, so the map can show what is being heard now
        # rather than only what finished being heard.
        self.live = live if live is not None else {}
        # The camera set this agent actually has, declared to the server so it
        # can converge. Before this, sensor rows were created only inside the
        # pair function, so a camera added after pairing had nowhere to land:
        # its events uploaded, the server could not map camera_id to a sensor,
        # and dropped every one of them without telling anybody.
        self.cameras = cameras or []
        state = self._load_state()
        self.events = Outbox(data_dir / "events.jsonl", state.get("events_offset", 0))
        self.passes = Outbox(data_dir / "passes.jsonl", state.get("passes_offset", 0))

    def _load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "events_offset": self.events.offset,
            "passes_offset": self.passes.offset,
        }))
        tmp.replace(self.state_path)  # atomic, so a crash cannot corrupt the cursor

    def send_once(self) -> dict | None:
        """Upload one batch and the current listening state.

        Status is sent even with nothing else to report - that is the whole
        point of it, and it doubles as the liveness signal that tells the map a
        sensor is still there.
        """
        events, ev_next = self.events.read_batch()
        passes, pa_next = self.passes.read_batch()
        status = dict(self.live)
        if not events and not passes and not status:
            return None

        payload = {"events": events, "passes": passes, "status": status}
        if self.cameras:
            payload["cameras"] = [
                {
                    "camera_id": c["id"],
                    "lat": coarse(float(c["lat"])),
                    "lon": coarse(float(c["lon"])),
                    "elevation_m": float(c.get("elevation_m", 0)),
                    "mount_height_m": float(c.get("mount_height_m", 0)),
                }
                for c in self.cameras
                if c.get("id") and c.get("lat") is not None and c.get("lon") is not None
            ]

        result = _post(self.url, payload, token=self.token)
        self.events.offset, self.passes.offset = ev_next, pa_next
        self._save_state()
        if events or passes:
            log.info("uploaded %d event(s), %d pass(es)", len(events), len(passes))

        # The server tells us what it threw away. Not logging this is how a
        # second camera could stream into a black hole for days.
        for camera_id in (result or {}).get("registered") or []:
            log.info("camera %r registered with the cloud - it will appear on the map",
                     camera_id)
        dropped = (result or {}).get("skipped") or []
        if dropped:
            log.warning("the server discarded %d event(s) it could not place: %s",
                        len(dropped), ", ".join(str(d) for d in dropped[:5]))
        return result

    def run(self, stop: threading.Event) -> None:
        fails = 0
        while not stop.is_set():
            try:
                self.send_once()
                fails = 0
                delay = self.interval_s
            except urllib.error.HTTPError as e:
                detail = _error_body(e)
                if e.code in (401, 403):
                    # Revoked or wrong token: retrying cannot help.
                    log.error("upload rejected (%s): %s - stopping uploader", e.code, detail)
                    return
                fails += 1
                delay = min(self.interval_s * 2 ** fails, self.max_backoff_s)
                log.warning("upload failed (%s): %s, retry in %.0fs", e.code, detail, delay)
            except Exception as e:  # network blips must not kill the agent
                fails += 1
                delay = min(self.interval_s * 2 ** fails, self.max_backoff_s)
                log.warning("upload failed: %s, retry in %.0fs", e, delay)
            stop.wait(delay)

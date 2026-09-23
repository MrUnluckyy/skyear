"""Polls live ADS-B positions and keeps a short per-aircraft track history."""
from __future__ import annotations
import collections
import json
import logging
import threading
import time
import urllib.error
import urllib.request

from .geo import FT

log = logging.getLogger("adsb")

PROVIDERS = {
    "adsb.fi": "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}",
    "adsb.lol": "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}",
    # airplanes.live closed its open API: anonymous requests get 403 with a note
    # to email contact@airplanes.live. Kept for operators who were granted
    # access, but it fails every poll for everyone else - do not put it in the
    # default rotation.
    "airplanes.live": "https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}",
}

# Rotation order for the free APIs. Measured 2026-09-23, one client, 10 s poll,
# 48 requests each: adsb.lol shed 8 of 48 (17%), adsb.fi none. That is the
# provider shedding load, not us exceeding a rate - we were two orders of
# magnitude under the burst limit. Neither is dependable alone and neither sends
# Retry-After, so the fix is to rotate away from a shedding provider rather than
# to sit out a backoff.
FREE_PROVIDERS = ("adsb.fi", "adsb.lol")

LOCAL_PROVIDER = "readsb"


def _provider_list(provider):
    """Normalise the configured provider into a rotation order.

    A single name is a *preference*, not an exclusive choice: the other free
    APIs stay behind it as fallbacks. Pin exactly one by configuring a one-item
    list. A local `readsb` never falls back to the internet - an operator who
    put up an antenna expects their own receiver, not a silent switch to a
    public API with different provenance.
    """
    if isinstance(provider, str):
        names = [provider.strip()]
        if names[0] != LOCAL_PROVIDER:
            names += [p for p in FREE_PROVIDERS if p != names[0]]
    else:
        names = [str(p).strip() for p in provider if str(p).strip()] or list(FREE_PROVIDERS)
    unknown = [n for n in names if n != LOCAL_PROVIDER and n not in PROVIDERS]
    if unknown:
        raise ValueError(f"unknown ADS-B provider(s) {unknown}; "
                         f"valid: {sorted(PROVIDERS) + [LOCAL_PROVIDER]}")
    return names


class AdsbTracker:
    def __init__(self, provider, lat, lon, radius_nm=15, poll_s=10.0, readsb_url=None,
                 history_s=900, max_backoff_s=300.0, rate_limit_backoff_s=60.0,
                 switch_delay_s=1.0, health_every_s=900.0):
        self.providers = _provider_list(provider)
        self.pi = 0
        self.tried = set()   # providers that have failed since the last success
        self.lat, self.lon = lat, lon
        self.radius_nm, self.poll_s = radius_nm, max(poll_s, 2.0)
        self.max_backoff_s = max_backoff_s
        self.rate_limit_backoff_s = rate_limit_backoff_s
        self.switch_delay_s = switch_delay_s
        self.health_every_s = health_every_s
        self.readsb_url = readsb_url
        self.history_s = history_s
        self.tracks = {}   # hex -> deque[(t, lat, lon, alt_m)]
        self.meta = {}     # hex -> {flight, type, reg, category}
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.last_ok = 0.0
        self.stats = collections.defaultdict(collections.Counter)

    @property
    def provider(self):
        return self.providers[self.pi]

    def _url(self):
        if self.provider == LOCAL_PROVIDER:
            return self.readsb_url
        return PROVIDERS[self.provider].format(lat=f"{self.lat:.4f}", lon=f"{self.lon:.4f}", nm=int(self.radius_nm))

    def poll_once(self):
        req = urllib.request.Request(self._url(), headers={"User-Agent": "skyear-agent/0.1"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
        self.ingest(data)

    def ingest(self, data):
        now = data.get("now") or time.time()
        if now > 1e12:
            now /= 1000.0
        planes = data.get("ac") or data.get("aircraft") or []
        with self.lock:
            for a in planes:
                if a.get("lat") is None or a.get("lon") is None:
                    continue
                alt = a.get("alt_geom")
                if alt is None:
                    alt = a.get("alt_baro")
                if alt == "ground":
                    alt = 0
                if alt is None:
                    continue
                t = now - float(a.get("seen_pos", 0) or 0)
                hx = a["hex"].lower()
                tr = self.tracks.setdefault(hx, collections.deque(maxlen=2000))
                if tr and t <= tr[-1][0] + 0.5:
                    continue
                tr.append((t, float(a["lat"]), float(a["lon"]), float(alt) * FT))
                self.meta[hx] = {
                    "flight": (a.get("flight") or "").strip() or None,
                    "type": a.get("t"),
                    "reg": a.get("r"),
                    "category": a.get("category"),
                    "on_ground": a.get("alt_baro") == "ground",
                }
            cutoff = time.time() - self.history_s
            for hx in [h for h, tr in self.tracks.items() if not tr or tr[-1][0] < cutoff]:
                self.tracks.pop(hx, None)
                self.meta.pop(hx, None)
        self.last_ok = time.time()

    def position_at(self, hx, t, max_gap_s=30.0):
        with self.lock:
            tr = self.tracks.get(hx)
            if not tr:
                return None
            pts = list(tr)
        if t < pts[0][0] - max_gap_s or t > pts[-1][0] + max_gap_s:
            return None
        if t <= pts[0][0]:
            return pts[0][1:]
        if t >= pts[-1][0]:
            return pts[-1][1:]
        for (t1, *p1), (t2, *p2) in zip(pts, pts[1:]):
            if t1 <= t <= t2:
                if t2 - t1 > max_gap_s * 2:
                    return None
                k = (t - t1) / (t2 - t1) if t2 > t1 else 0
                return tuple(a + (b - a) * k for a, b in zip(p1, p2))
        return None

    def snapshot(self):
        with self.lock:
            return {h: (dict(self.meta.get(h, {})), tr[-1]) for h, tr in self.tracks.items() if tr}

    def blind_for(self, now=None) -> float:
        """Seconds since the last successful poll, measured from startup if
        there has never been one. Consumers use this to tell "the aircraft left"
        apart from "we stopped being able to see anything"."""
        return (now or time.time()) - (self.last_ok or self.started_at)

    def blind_during(self, t0: float, t1: float, now: float | None = None) -> float:
        """Seconds of the window [t0, t1] that had no successful poll behind them.

        Only the current outage is known - no outage history is kept - so this is
        the overlap of [last_ok, now] with the window. That is the case that
        matters: an event is judged moments after it ends, so if the feed was
        down while the sound happened it is almost certainly still down now.
        """
        now = time.time() if now is None else now
        return max(0.0, min(t1, now) - max(t0, self.last_ok or self.started_at))

    def rotate(self) -> bool:
        """Switch to the next provider that has not failed since the last
        success, returning True if there was one.

        With two free APIs a shed request costs a switch instead of a blind
        window, because the one that shed and the one that did not are rarely
        the same on any given minute.
        """
        for step in range(1, len(self.providers) + 1):
            cand = (self.pi + step) % len(self.providers)
            if self.providers[cand] not in self.tried:
                self.pi = cand
                return True
        # Every provider failed this round. Start the next round on a different
        # one and let the caller back off.
        self.tried.clear()
        self.pi = (self.pi + 1) % len(self.providers)
        return False

    def next_delay(self, fails: int, retry_after: float | None = None,
                   rate_limited: bool = False, switching: bool = False) -> float:
        """Seconds to wait before the next poll.

        Backs off exponentially while every provider is unhappy, because these
        are free community APIs and retrying at the normal rate is what earns an
        IP ban. A Retry-After header always wins. Two caps, because the two
        failures are not alike: a 429 is transient load shedding and clears in
        seconds, while a dead network deserves the long cap. Sitting out five
        minutes over a shed request costs more aircraft passes than it saves
        requests.
        """
        if fails <= 0:
            return self.poll_s
        if switching:
            return min(self.switch_delay_s, self.poll_s)
        cap = self.rate_limit_backoff_s if rate_limited else self.max_backoff_s
        if retry_after is not None:
            return max(self.poll_s, min(retry_after, cap))
        return min(self.poll_s * (2 ** fails), cap)

    @staticmethod
    def retry_after_seconds(exc) -> float | None:
        """Read Retry-After off an HTTPError, if the provider sent one."""
        headers = getattr(exc, "headers", None)
        if not headers:
            return None
        raw = headers.get("Retry-After")
        if raw is None:
            return None
        try:
            return float(str(raw).strip())
        except ValueError:
            return None  # HTTP-date form; fall back to exponential backoff

    @staticmethod
    def is_rate_limited(exc) -> bool:
        return getattr(exc, "code", None) == 429

    def _log_health(self):
        """One periodic line, so a quiet log still says the feed is alive."""
        parts = []
        for name in self.providers:
            s = self.stats.get(name)
            if s:
                parts.append(f"{name} {s['ok']}ok/{s['limited']}limited/{s['error']}err")
        if parts:
            log.info("ADS-B %s, on %s", ", ".join(parts), self.provider)
        self.stats.clear()

    def run(self, stop: threading.Event):
        err_logged = 0.0
        fails = 0
        suppressed = 0
        down_since = 0.0
        health_at = time.time()
        while not stop.is_set():
            try:
                self.poll_once()
                self.stats[self.provider]["ok"] += 1
                if fails:
                    outage = time.time() - down_since
                    # A single shed request that the next provider absorbed is
                    # not news. Logging it at INFO every time is what buried the
                    # real problems in the agent log.
                    emit = log.info if fails >= 3 or outage > 60 else log.debug
                    emit("ADS-B recovered on %s after %d failed poll(s), %.0fs blind",
                         self.provider, fails, outage)
                fails, suppressed = 0, 0
                self.tried.clear()
                delay = self.poll_s
            except Exception as e:  # network hiccups must not kill the agent
                if not fails:
                    down_since = time.time()
                fails += 1
                limited = self.is_rate_limited(e)
                self.stats[self.provider]["limited" if limited else "error"] += 1
                self.tried.add(self.provider)
                switching = self.rotate()
                delay = self.next_delay(fails, self.retry_after_seconds(e), limited, switching)
                if switching:
                    log.debug("ADS-B switching to %s after %s", self.provider, e)
                elif time.time() - err_logged > 60:
                    extra = f" ({suppressed} more suppressed)" if suppressed else ""
                    log.warning("ADS-B poll failed %dx%s on every provider, next try in %.0fs: %s",
                                fails, extra, delay, e)
                    err_logged, suppressed = time.time(), 0
                else:
                    suppressed += 1
            if time.time() - health_at >= self.health_every_s:
                self._log_health()
                health_at = time.time()
            stop.wait(delay)

"""Polls live ADS-B positions and keeps a short per-aircraft track history."""
import collections
import json
import logging
import threading
import time
import urllib.request

from .geo import FT

log = logging.getLogger("adsb")

PROVIDERS = {
    "adsb.lol": "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}",
    "airplanes.live": "https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}",
}


class AdsbTracker:
    def __init__(self, provider, lat, lon, radius_nm=15, poll_s=5.0, readsb_url=None, history_s=900):
        self.provider, self.lat, self.lon = provider, lat, lon
        self.radius_nm, self.poll_s = radius_nm, max(poll_s, 2.0)
        self.readsb_url = readsb_url
        self.history_s = history_s
        self.tracks = {}   # hex -> deque[(t, lat, lon, alt_m)]
        self.meta = {}     # hex -> {flight, type, reg, category}
        self.lock = threading.Lock()
        self.last_ok = 0.0

    def _url(self):
        if self.provider == "readsb":
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

    def run(self, stop: threading.Event):
        err_logged = 0.0
        while not stop.is_set():
            try:
                self.poll_once()
            except Exception as e:  # network hiccups must not kill the agent
                if time.time() - err_logged > 60:
                    log.warning("ADS-B poll failed: %s", e)
                    err_logged = time.time()
            stop.wait(self.poll_s)

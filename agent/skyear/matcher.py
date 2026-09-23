"""Links sound events to aircraft, accounting for sound travel time, and
records every nearby aircraft pass (heard or not) for range statistics."""
import threading
import time

from .geo import SPEED_OF_SOUND, slant


def emission_geometry(adsb, hx, sensor, t_arrival, c=SPEED_OF_SOUND):
    """Where was the aircraft when it emitted the sound arriving at t_arrival?"""
    te = t_arrival
    geo = None
    for _ in range(6):
        p = adsb.position_at(hx, te)
        if p is None:
            return None
        geo = slant(sensor, *p)
        te = t_arrival - geo[0] / c
    s, h, elev, brg = geo
    lat, lon, alt = adsb.position_at(hx, te)
    return {"slant_m": round(s), "horizontal_m": round(h), "elevation_deg": round(elev, 1),
            "bearing_deg": round(brg), "alt_m": round(alt), "lat": round(lat, 5), "lon": round(lon, 5),
            "delay_s": round(s / c, 1)}


def match_event(adsb, sensor, event, max_range_m, max_fix_age_s=60.0,
                track_ground=False, now=None):
    """Rank aircraft that could have emitted this sound, nearest first.

    Ground clutter is excluded by default. An airport apron holds many parked
    transponders at a constant few km from the sensor, and because candidates
    are ranked by slant range they would otherwise outrank genuine aircraft
    further out and steal the label from every real detection.
    """
    now = now if now is not None else time.time()
    cands = []
    for hx, (meta, (t_fix, _, _, alt)) in adsb.snapshot().items():
        if now - t_fix > max_fix_age_s:
            continue
        if not track_ground and (meta.get("on_ground") or alt <= 0):
            continue
        g = emission_geometry(adsb, hx, sensor, event["peak_time"])
        if g and g["slant_m"] <= max_range_m:
            cands.append({"hex": hx, **meta, **g})
    cands.sort(key=lambda c: c["slant_m"])
    return cands[:5]


def _blind_for(adsb, now):
    """Seconds the ADS-B feed has been down, or 0 for a source that cannot say.

    Test fakes and local receivers need not implement it; only the polling
    tracker knows when it lost the feed.
    """
    fn = getattr(adsb, "blind_for", None)
    return fn(now) if fn else 0.0


class PassTracker:
    """Tracks closest approach of each aircraft to a sensor; emits a pass record
    once it has moved away, noting whether any sound event lined up with it."""

    def __init__(self, adsb, sensor, radius_m, on_pass, max_fix_age_s=60.0,
                 track_ground=False, reopen_cooldown_s=120.0, blind_hold_max_s=600.0):
        self.adsb, self.sensor, self.radius_m, self.on_pass = adsb, sensor, radius_m, on_pass
        self.max_fix_age_s = max_fix_age_s
        self.blind_hold_max_s = blind_hold_max_s
        self.track_ground = track_ground
        self.reopen_cooldown_s = reopen_cooldown_s
        self.open = {}       # hex -> pass dict
        self.closed_at = {}  # hex -> when its last pass was emitted
        self.events = []     # recent (start, end, event_id, matched_hex)
        self.lock = threading.Lock()

    def add_event(self, event, matched_hex):
        with self.lock:
            self.events.append((event["start"], event["end"], event["id"], matched_hex))
            cutoff = time.time() - 3600
            self.events = [e for e in self.events if e[1] > cutoff]

    def tick(self, now=None):
        now = now or time.time()
        blind = _blind_for(self.adsb, now)
        snap = self.adsb.snapshot()
        for hx, (meta, (t, lat, lon, alt)) in snap.items():
            # A parked transponder keeps reporting the same frozen fix. Without
            # this guard its pass closes on staleness and immediately reopens,
            # emitting a duplicate record on every tick.
            if now - t > self.max_fix_age_s:
                continue
            # Surface traffic is not an aircraft pass and would skew range stats.
            if not self.track_ground and (meta.get("on_ground") or alt <= 0):
                continue
            s, h, elev, _ = slant(self.sensor, lat, lon, alt)
            p = self.open.get(hx)
            if s <= self.radius_m:
                if p is None:
                    if now - self.closed_at.get(hx, float("-inf")) < self.reopen_cooldown_s:
                        continue  # just emitted a pass for this aircraft
                    p = self.open[hx] = {"hex": hx, **meta, "first_t": t, "min_slant_m": s, "t_min": t,
                                         "alt_m_at_min": alt, "elev_deg_at_min": elev}
                if s < p["min_slant_m"]:
                    p.update(min_slant_m=s, t_min=t, alt_m_at_min=alt, elev_deg_at_min=elev, **meta)
                p["last_t"] = t
        for hx in list(self.open):
            p = self.open[hx]
            # The feed being down is not the aircraft leaving. Closing a pass
            # during a blind window records a closest approach that never
            # happened - and once the feed returns the same aircraft opens a
            # second pass, so one real pass lands in the range stats twice, both
            # times wrong. Hold instead, and stamp the pass so the analysis can
            # discount it. Past blind_hold_max_s the aircraft is genuinely long
            # gone; close it, flagged, rather than hold open forever.
            if blind > self.max_fix_age_s:
                p["adsb_gap_s"] = max(p.get("adsb_gap_s", 0.0), blind)
                if blind < self.blind_hold_max_s:
                    continue
            gone = hx not in snap or now - p["last_t"] > 90
            if not gone:
                _, (t, lat, lon, alt) = snap[hx]
                gone = slant(self.sensor, lat, lon, alt)[0] > self.radius_m and now - p["last_t"] > 30
            if gone:
                self.closed_at[hx] = now
                self._close(self.open.pop(hx))
        # keep the cooldown map from growing without bound
        for hx in [h for h, t in self.closed_at.items() if now - t > self.reopen_cooldown_s * 10]:
            self.closed_at.pop(hx, None)

    def _close(self, p):
        arrival = p["t_min"] + p["min_slant_m"] / SPEED_OF_SOUND
        with self.lock:
            hits = [e for e in self.events
                    if e[3] == p["hex"] or (e[3] is None and e[0] - 20 <= arrival <= e[1] + 20)]
        self.on_pass({
            "hex": p["hex"], "flight": p.get("flight"), "type": p.get("type"), "reg": p.get("reg"),
            "closest_time": round(p["t_min"], 1), "min_slant_m": round(p["min_slant_m"]),
            "alt_m": round(p["alt_m_at_min"]), "elevation_deg": round(p["elev_deg_at_min"], 1),
            "heard": bool(hits), "event_ids": [e[2] for e in hits],
            "on_ground": p.get("on_ground", False),
            "adsb_gap_s": round(p.get("adsb_gap_s", 0.0), 1),
        })

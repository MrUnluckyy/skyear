"""Which way a sound came from, when a site has more than one microphone.

WHY THIS IS THE DRONE WORK AND NOT A SIDE FEATURE

`rotor.py` ends by saying that a single microphone cannot separate a Shahed from
a scooter on spectrum, and that separation has to come from altitude,
persistence, and whether several sensors hear the same thing. All three need
direction. A bearing from one site is also what crosses with a bearing from
another site to locate a source - and unlike arrival-time multilateration, that
does not need the sub-millisecond timestamps this project does not have. Two
sites agreeing on where a sound was needs events matched within seconds, which
`time.time()` already supports.

WHAT IT MEASURES

Cameras at one address face different ways. A camera's own housing and the wall
behind it shadow sound arriving from behind, so the same aircraft is a few dB
louder on the camera pointing at it. Comparing the cameras gives a bearing.

The comparison is on `snr_db`, not on absolute level, because each camera has
its own gain - possibly its own automatic gain control - and SNR is measured
against that camera's own noise floor, so a fixed gain difference cancels.

WHAT IT CANNOT DO, AND WHY THAT IS FINE FOR NOW

The estimate is a power-weighted circular mean of the bearings of the cameras
that heard it, so it can never point outside the arc those cameras span. Two
cameras facing east and south cannot report north-west; they will report
something between east and south, quietly. `arc_deg` is on every record for
exactly this reason - a narrow arc means the estimate is interpolating inside a
sliver and is not to be trusted as an absolute direction.

Nor is the mapping from level difference to angle calibrated. It is not even
the same at two sites: a reflecting wall biases one site systematically, and
that bias does not average out with more events or more sites.

What makes this worth building anyway is that the bias is *learnable per site,
for free*. Every record that matched an aircraft carries `true_bearing_deg` from
ADS-B beside the estimate. Thousands of labelled pairs accumulate per site with
no work from the owner, which is the same trick the rest of the project runs on.
Until that calibration exists this module reports measurements, not verdicts.

One camera is not nothing. A sound only the west-facing camera heard is already
information, so a single-camera group is still recorded, with `cameras: 1` to
say what it is.
"""
from __future__ import annotations

import logging
import math
import threading
import time

from .geo import slant

log = logging.getLogger("direction")

# Two cameras at one address are co-located as far as a source kilometres away
# is concerned. Beyond this they are different sites and comparing their levels
# measures distance, not direction.
SITE_RADIUS_M = 150.0

# RTSP latency differs per camera by 0.5-2 s, so two recordings of one sound do
# not start at the same timestamp. Intervals are compared with this much slack.
SKEW_S = 3.0

# How long to wait after the last event in a group before deciding it is
# complete. Long enough for a slower stream to deliver the same sound.
SETTLE_S = 8.0


def group_sites(cameras, radius_m=SITE_RADIUS_M):
    """Cluster cameras into sites by position, single-link within `radius_m`.

    An explicit `site` in a camera's config always wins - two buildings in one
    yard are one cluster by distance and two sites in reality, and only the
    owner knows which.
    """
    out, unplaced = {}, []
    for c in cameras:
        if c.get("site"):
            out[c["id"]] = str(c["site"])
        else:
            unplaced.append(c)

    clusters = []  # each a list of camera dicts
    for c in unplaced:
        for cl in clusters:
            if any(_near(c, other, radius_m) for other in cl):
                cl.append(c)
                break
        else:
            clusters.append([c])
    # Single-link clustering can leave two clusters that are now within range of
    # each other through a camera added later; merge until it settles.
    merged = True
    while merged:
        merged = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if any(_near(a, b, radius_m) for a in clusters[i] for b in clusters[j]):
                    clusters[i] += clusters[j]
                    del clusters[j]
                    merged = True
                    break
            if merged:
                break

    for cl in clusters:
        name = min(c["id"] for c in cl)   # stable, and readable in a log
        for c in cl:
            out[c["id"]] = name
    return out


def _near(a, b, radius_m):
    s, _, _, _ = slant({"lat": a["lat"], "lon": a["lon"], "alt_m": 0.0},
                       b["lat"], b["lon"], 0.0)
    return s <= radius_m


def weighted_bearing(observations):
    """Power-weighted circular mean of the bearings that heard a sound.

    `observations` is [(bearing_deg, snr_db), ...]. Weights are linear power
    relative to the quietest camera, so a camera 6 dB louder counts four times.
    Returns (bearing_deg, concentration, arc_deg), where concentration is 0-1
    and arc_deg is the angular span the cameras cover - a narrow arc means the
    bearing is interpolated inside a sliver and constrains very little.
    """
    if not observations:
        return None, 0.0, 0.0
    quietest = min(s for _, s in observations)
    x = y = w_total = 0.0
    for bearing, snr in observations:
        w = 10.0 ** ((snr - quietest) / 10.0)
        r = math.radians(bearing)
        x += w * math.cos(r)
        y += w * math.sin(r)
        w_total += w
    if w_total == 0:
        return None, 0.0, 0.0
    # Rounded before the final wrap, or a hair under north comes back as 360.0 -
    # in range before rounding, out of it after.
    mean = round(math.degrees(math.atan2(y, x)) % 360.0, 1) % 360.0
    concentration = math.hypot(x, y) / w_total
    return mean, round(concentration, 3), round(_arc([b for b, _ in observations]), 1)


def _arc(bearings):
    """Angular span covered by a set of bearings, 0 for one, <=360."""
    if len(bearings) < 2:
        return 0.0
    b = sorted(x % 360.0 for x in bearings)
    gaps = [(b[i + 1] - b[i]) for i in range(len(b) - 1)] + [360.0 - b[-1] + b[0]]
    return 360.0 - max(gaps)


class DirectionTracker:
    """Joins events that several cameras at one site recorded of one sound.

    Runs on a tick loop and emits its own records rather than annotating events,
    the way PassTracker does: a camera worker writes its event the moment it has
    one, and the sound's other recordings have not necessarily arrived yet.
    """

    def __init__(self, sites, bearings, on_bearing, settle_s=SETTLE_S, skew_s=SKEW_S):
        self.sites = sites          # camera id -> site id
        self.bearings = bearings    # camera id -> which way it faces, degrees
        self.on_bearing = on_bearing
        self.settle_s, self.skew_s = settle_s, skew_s
        self.open = {}              # site id -> group dict
        self.lock = threading.Lock()

    def add_event(self, cam_id, event, matched=None):
        """Offer an event. Wind is skipped: it is made at the microphone, so a
        direction for it would be a direction for the weather."""
        if event.get("likely_wind"):
            return
        site = self.sites.get(cam_id)
        if site is None or cam_id not in self.bearings:
            return
        obs = {
            "camera": cam_id,
            "event_id": event.get("id"),
            "bearing_deg": self.bearings[cam_id],
            "snr_db": event.get("snr_db"),
            "start": event["start"],
            "end": event["end"],
        }
        if obs["snr_db"] is None:
            return
        with self.lock:
            g = self.open.get(site)
            if g and self._overlaps(g, event):
                # One camera can produce two events for one continuous sound;
                # keep the loudest rather than counting it twice.
                prev = next((o for o in g["obs"] if o["camera"] == cam_id), None)
                if prev is None:
                    g["obs"].append(obs)
                elif obs["snr_db"] > prev["snr_db"]:
                    g["obs"][g["obs"].index(prev)] = obs
                g["start"] = min(g["start"], event["start"])
                g["end"] = max(g["end"], event["end"])
            else:
                if g:
                    self._close(site, g)
                g = self.open[site] = {"site": site, "obs": [obs],
                                       "start": event["start"], "end": event["end"],
                                       "true_bearing_deg": None, "hex": None}
            if matched and g["true_bearing_deg"] is None:
                # ADS-B's own bearing to the aircraft, which is what makes this
                # a labelled example rather than a reading.
                g["true_bearing_deg"] = matched.get("bearing_deg")
                g["hex"] = matched.get("hex")

    def _overlaps(self, group, event):
        return (event["start"] <= group["end"] + self.skew_s
                and event["end"] >= group["start"] - self.skew_s)

    def tick(self, now=None):
        now = now or time.time()
        with self.lock:
            for site, g in list(self.open.items()):
                if now - g["end"] > self.settle_s:
                    self._close(site, g)

    def _close(self, site, group):
        self.open.pop(site, None)
        obs = group["obs"]
        bearing, concentration, arc = weighted_bearing(
            [(o["bearing_deg"], o["snr_db"]) for o in obs])
        rec = {
            "site": site,
            "start": round(group["start"], 1),
            "end": round(group["end"], 1),
            "cameras": len(obs),
            "bearing_deg": bearing,
            "concentration": concentration,
            "arc_deg": arc,
            "heard": [{"camera": o["camera"], "event_id": o["event_id"],
                       "bearing_deg": o["bearing_deg"], "snr_db": o["snr_db"]}
                      for o in sorted(obs, key=lambda o: -o["snr_db"])],
            # Present when ADS-B explained the sound. Estimate and truth side by
            # side is the per-site calibration set, accumulating for free.
            "true_bearing_deg": group["true_bearing_deg"],
            "hex": group["hex"],
        }
        if rec["true_bearing_deg"] is not None and bearing is not None:
            rec["error_deg"] = round(_signed_diff(bearing, rec["true_bearing_deg"]), 1)
        self.on_bearing(rec)


def _signed_diff(a, b):
    """a - b, wrapped to (-180, 180]."""
    return (a - b + 180.0) % 360.0 - 180.0

"""Guards against junk pass records.

All three regressions here were found by the first live run against VNO traffic
on 2026-09-17: parked ground transponders at the airport produced a duplicate
pass record on every tick, which would have poisoned the heard/not-heard stats.
"""
import time

from conftest import SENSOR, FakeAdsb

from skyear.matcher import PassTracker


class Frozen:
    """A transponder parked inside the radius whose fix never advances."""

    def __init__(self, t_fix, alt_m=0.0, on_ground=True, hex_id="503eff"):
        self.hex = hex_id
        self.t_fix = t_fix
        self.alt = alt_m
        self.meta = {"flight": "AOS96", "type": None, "on_ground": on_ground}

    def snapshot(self):
        # sitting ~1 km north of the sensor, well inside any sane radius
        return {self.hex: (dict(self.meta), (self.t_fix, SENSOR["lat"] + 0.009,
                                             SENSOR["lon"], self.alt))}


def test_stale_fix_never_opens_a_pass():
    """The exact runaway loop: frozen fix, close on staleness, reopen, repeat."""
    t0 = time.time()
    out = []
    adsb = Frozen(t_fix=t0 - 124, alt_m=300.0, on_ground=False)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append)
    for i in range(20):
        pt.tick(now=t0 + i * 5)
    assert out == [], f"a parked transponder emitted {len(out)} pass records"


def test_ground_traffic_is_excluded():
    t0 = time.time()
    out = []
    adsb = Frozen(t_fix=t0, on_ground=True, alt_m=0.0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append)
    for i in range(20):
        adsb.t_fix = t0 + i * 5          # fresh fixes, but still on the ground
        pt.tick(now=t0 + i * 5)
    assert out == []


def test_ground_traffic_can_be_opted_into():
    t0 = time.time()
    out = []
    adsb = Frozen(t_fix=t0, on_ground=True, alt_m=0.0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append, track_ground=True)
    for i in range(30):
        adsb.t_fix = t0 + i * 5
        pt.tick(now=t0 + i * 5)
    adsb.t_fix = t0                       # goes quiet
    pt.tick(now=t0 + 400)
    assert len(out) == 1


def test_cooldown_prevents_an_immediate_second_record():
    """An ADS-B gap must not split one pass into two records."""
    t0 = time.time()
    out = []
    adsb = FakeAdsb(speed_mps=200.0, t_closest=t0, offset_north_m=1500.0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append, reopen_cooldown_s=120)

    for dt in (-30, -15, 0, 15, 30):
        adsb.now = t0 + dt
        pt.tick(now=t0 + dt)
    adsb.now = t0 + 300
    pt.tick(now=t0 + 300)                 # closes the pass
    assert len(out) == 1

    # the aircraft is briefly back inside the radius right after closing
    adsb.now = t0 + 310
    adsb.t_closest = t0 + 310
    pt.tick(now=t0 + 310)
    pt.tick(now=t0 + 315)
    assert len(out) == 1, "cooldown should suppress an immediate reopen"


def test_a_genuine_later_pass_still_records_after_the_cooldown():
    t0 = time.time()
    out = []
    adsb = FakeAdsb(speed_mps=200.0, t_closest=t0, offset_north_m=1500.0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append, reopen_cooldown_s=120)

    for dt in (-30, 0, 30):
        adsb.now = t0 + dt
        pt.tick(now=t0 + dt)
    adsb.now = t0 + 300
    pt.tick(now=t0 + 300)
    assert len(out) == 1

    later = t0 + 1000                     # a real second approach, well after
    adsb.t_closest = later
    for dt in (-30, 0, 30):
        adsb.now = later + dt
        pt.tick(now=later + dt)
    adsb.now = later + 300
    pt.tick(now=later + 300)
    assert len(out) == 2


def test_airborne_traffic_with_fresh_fixes_is_unaffected():
    """The guards must not suppress the aircraft we actually care about."""
    t0 = time.time()
    out = []
    adsb = FakeAdsb(speed_mps=200.0, t_closest=t0, offset_north_m=1500.0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append)
    for dt in (-30, -15, 0, 15, 30):
        adsb.now = t0 + dt
        pt.tick(now=t0 + dt)
    adsb.now = t0 + 300
    pt.tick(now=t0 + 300)
    assert len(out) == 1
    assert out[0]["flight"] == "BTI4TK"
    assert out[0]["alt_m"] == 1000

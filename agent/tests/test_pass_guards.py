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


class GoesBlind:
    """One aircraft mid-pass, and an ADS-B feed that stops answering.

    While blind the snapshot keeps returning the last fix it ever got, which is
    exactly what the real tracker does - it has nothing newer to hand out.
    """

    def __init__(self, base, hex_id="4ca7b1"):
        self.inner = FakeAdsb(hex_id=hex_id, t_closest=base)
        self.hex = hex_id
        self.last_seen = base
        self.blind_s = 0.0

    def see(self, t):
        """The feed answers: the fix advances to t."""
        self.inner.now = self.last_seen = t
        self.blind_s = 0.0

    def go_blind(self, now):
        self.blind_s = now - self.last_seen

    def snapshot(self):
        return self.inner.snapshot()

    def blind_for(self, now=None):
        return self.blind_s


def test_a_blind_feed_does_not_close_a_pass_or_invent_a_closest_approach():
    """The 429 storms in the 2026-09-22 log did this silently.

    An aircraft is inside the radius when the feed goes down. Its last fix then
    ages past the 90 s staleness threshold, and the pass used to close on it -
    recording a closest approach of wherever the aircraft happened to be when we
    lost sight of it, as a `not heard` at that wrong range. Once the feed came
    back the same aircraft opened a second pass, so one real pass reached the
    range stats twice and neither entry was true.
    """
    base = 1_000_000.0
    out = []
    adsb = GoesBlind(base)
    pt = PassTracker(adsb, SENSOR, 40_000, on_pass=out.append)

    # seen approaching, 30 km out: the pass opens
    adsb.see(base - 150)
    pt.tick(now=base - 150)
    assert len(pt.open) == 1

    # the feed dies, right before the real closest approach at `base`
    for now in range(int(base - 140), int(base + 140), 10):
        adsb.go_blind(now)
        pt.tick(now=now)

    assert out == [], "a pass was closed while we could not see anything"
    assert len(pt.open) == 1, "the pass must stay open until the feed returns"

    # the feed returns, the aircraft is on its way out, and the pass closes
    adsb.see(base + 140)
    pt.tick(now=base + 140)
    adsb.see(base + 250)
    pt.tick(now=base + 250)

    assert len(out) == 1, "one real pass must produce exactly one record"
    rec = out[0]
    assert rec["adsb_gap_s"] >= 280, "the blind window must be on the record"
    # and the honest part: the recorded closest approach is the best we saw,
    # not the true 1500 m, which is precisely what adsb_gap_s warns about
    assert rec["min_slant_m"] > 10_000


def test_a_healthy_feed_records_no_gap():
    t0 = time.time()
    out = []
    adsb = FakeAdsb(t_closest=t0)
    pt = PassTracker(adsb, SENSOR, 8000, on_pass=out.append)
    for i in range(-40, 100, 5):   # far enough past for the pass to close
        adsb.now = t0 + i
        pt.tick(now=t0 + i)
    assert out and all(r["adsb_gap_s"] == 0.0 for r in out)


def test_an_endless_outage_eventually_closes_the_pass():
    """Holding is right for a minute or two; holding forever leaks passes that
    will never be resolved."""
    base = 1_000_000.0
    out = []
    adsb = GoesBlind(base)
    pt = PassTracker(adsb, SENSOR, 40_000, on_pass=out.append, blind_hold_max_s=300.0)

    adsb.see(base - 150)
    pt.tick(now=base - 150)
    for now in range(int(base - 140), int(base + 400), 10):
        adsb.go_blind(now)
        pt.tick(now=now)

    assert len(out) == 1
    assert out[0]["adsb_gap_s"] >= 300

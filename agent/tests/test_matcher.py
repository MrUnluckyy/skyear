import math
import time

import pytest
from conftest import SENSOR, FakeAdsb

from skyear.geo import SPEED_OF_SOUND, slant
from skyear.matcher import PassTracker, emission_geometry, match_event


def test_emission_geometry_is_self_consistent():
    """The reported delay must equal the reported slant divided by c.

    This is the whole point of the iteration: solve for the position the sound
    was emitted from, not the position the aircraft is at when it arrives.
    """
    adsb = FakeAdsb(t_closest=1000.0)
    g = emission_geometry(adsb, adsb.hex, SENSOR, t_arrival=1000.0)
    assert g is not None
    assert g["delay_s"] == pytest.approx(g["slant_m"] / SPEED_OF_SOUND, abs=0.1)


def test_emission_position_lags_behind_the_live_position():
    """A moving aircraft is past the emission point by the time you hear it."""
    adsb = FakeAdsb(speed_mps=200.0, t_closest=1000.0)
    t_arrival = 1000.0
    g = emission_geometry(adsb, adsb.hex, SENSOR, t_arrival)

    live_lat, live_lon, _ = adsb.position_at(adsb.hex, t_arrival)
    # eastbound: the emission longitude must be west of the live longitude
    assert g["lon"] < live_lon
    # and the gap should be roughly speed * delay
    lag_m = (live_lon - g["lon"]) * (math.cos(math.radians(live_lat)) * 111194.93)
    assert lag_m == pytest.approx(200.0 * g["delay_s"], rel=0.15)


def test_naive_arrival_time_geometry_would_be_wrong():
    """Guards the bug this module exists to prevent."""
    adsb = FakeAdsb(speed_mps=250.0, t_closest=1000.0, offset_north_m=1500.0)
    t_arrival = 1000.0
    g = emission_geometry(adsb, adsb.hex, SENSOR, t_arrival)
    naive_slant = slant(SENSOR, *adsb.position_at(adsb.hex, t_arrival))[0]
    # at ~250 m/s over a ~5 s delay the aircraft moves >1 km; the two must differ
    assert abs(g["slant_m"] - naive_slant) > 100


def test_emission_geometry_returns_none_for_unknown_aircraft():
    adsb = FakeAdsb()
    assert emission_geometry(adsb, "ffffff", SENSOR, t_arrival=1000.0) is None


def test_match_event_filters_by_max_range_and_sorts_by_slant():
    adsb = FakeAdsb(t_closest=1000.0, offset_north_m=1500.0)
    event = {"peak_time": 1000.0}

    near = match_event(adsb, SENSOR, event, max_range_m=12000)
    assert len(near) == 1
    assert near[0]["hex"] == adsb.hex
    assert near[0]["flight"] == "BTI4TK"      # metadata is merged into the candidate
    assert near[0]["type"] == "BCS3"
    assert near[0]["slant_m"] <= 12000

    far = match_event(adsb, SENSOR, event, max_range_m=500)
    assert far == []                           # out of range, no match


def test_match_event_sorts_multiple_candidates_nearest_first():
    class TwoPlanes:
        def position_at(self, hx, t, max_gap_s=30.0):
            lat = SENSOR["lat"]
            lon = SENSOR["lon"]
            return (lat, lon, 1124.0) if hx == "near00" else (lat, lon, 6124.0)

        def snapshot(self):
            return {"far000": ({"flight": "FAR"}, (0, 0, 0, 0)),
                    "near00": ({"flight": "NEAR"}, (0, 0, 0, 0))}

    got = match_event(TwoPlanes(), SENSOR, {"peak_time": 0.0}, max_range_m=12000)
    assert [c["hex"] for c in got] == ["near00", "far000"]
    assert got[0]["slant_m"] < got[1]["slant_m"]


def _run_pass(heard_event=None, matched_hex=None, radius_m=8000):
    """Fly the aircraft in, past, and out; return the emitted pass record."""
    t0 = time.time()
    adsb = FakeAdsb(speed_mps=200.0, t_closest=t0, offset_north_m=1500.0)
    out = []
    pt = PassTracker(adsb, SENSOR, radius_m, on_pass=out.append)
    if heard_event is not None:
        pt.add_event(heard_event, matched_hex)

    for dt in (-30, -15, 0, 15, 30):        # inbound, closest, outbound
        adsb.now = t0 + dt
        pt.tick(now=t0 + dt)
    adsb.now = t0 + 300                      # far away now
    pt.tick(now=t0 + 300)                    # >30 s since last in-radius fix
    return out


def test_pass_tracker_records_closest_approach_and_not_heard():
    out = _run_pass()
    assert len(out) == 1
    p = out[0]
    assert p["hex"] == "4ca7b1"
    assert p["flight"] == "BTI4TK"
    assert p["type"] == "BCS3"
    assert p["heard"] is False
    assert p["event_ids"] == []
    # closest approach is the 1500 m offset combined with 876 m of height
    assert p["min_slant_m"] == pytest.approx(math.hypot(1500, 1000 - 124), abs=30)
    assert p["elevation_deg"] > 0


def test_pass_tracker_marks_heard_when_an_event_matched_that_aircraft():
    t0 = time.time()
    event = {"id": "abc123", "start": t0, "end": t0 + 30}
    out = _run_pass(heard_event=event, matched_hex="4ca7b1")
    assert out[0]["heard"] is True
    assert out[0]["event_ids"] == ["abc123"]


def test_pass_tracker_matches_unattributed_event_by_arrival_time():
    """An event with no aircraft match still counts if it lines up in time."""
    t0 = time.time()
    arrival = t0 + math.hypot(1500, 876) / SPEED_OF_SOUND
    event = {"id": "timed1", "start": arrival - 5, "end": arrival + 5}
    out = _run_pass(heard_event=event, matched_hex=None)
    assert out[0]["heard"] is True
    assert out[0]["event_ids"] == ["timed1"]


def test_pass_tracker_ignores_unrelated_event_far_in_time():
    t0 = time.time()
    event = {"id": "other1", "start": t0 - 900, "end": t0 - 880}
    out = _run_pass(heard_event=event, matched_hex=None)
    assert out[0]["heard"] is False


def test_aircraft_outside_the_radius_never_opens_a_pass():
    out = _run_pass(radius_m=500)   # closest approach is ~1.7 km, well outside
    assert out == []

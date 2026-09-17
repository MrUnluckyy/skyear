"""Ground clutter must not steal acoustic labels from real aircraft.

VNO's apron holds stationary transponders (ADSTEST, follow-me vehicles) at a
constant few km from the sensor. match_event ranks by slant range, so without
filtering they outrank genuine aircraft further out and become the label on
every event - which is what ML v0.2 would then train on.
"""
import time

from conftest import SENSOR, m_to_lat

from skyear.matcher import match_event


class Mixed:
    """One parked ground beacon close in, one real aircraft further out."""

    def __init__(self, now, ground_alt=0.0, ground_on_ground=True, ground_fix_age=0.0):
        self.now = now
        self.ground_fix_age = ground_fix_age
        self.ground_alt = ground_alt
        self.ground_on_ground = ground_on_ground

    def _pos(self, hx):
        if hx == "adstest":
            return (SENSOR["lat"] + m_to_lat(3000), SENSOR["lon"], self.ground_alt)
        return (SENSOR["lat"] + m_to_lat(6000), SENSOR["lon"], 900.0)

    def position_at(self, hx, t, max_gap_s=30.0):
        return self._pos(hx)

    def snapshot(self):
        return {
            "adstest": ({"flight": "ADSTEST", "on_ground": self.ground_on_ground},
                        (self.now - self.ground_fix_age, *self._pos("adstest"))),
            "502ce3": ({"flight": "BTI34K", "type": "BCS3", "on_ground": False},
                       (self.now, *self._pos("502ce3"))),
        }


def test_ground_beacon_does_not_steal_the_label():
    now = time.time()
    got = match_event(Mixed(now), SENSOR, {"peak_time": now}, 12000, now=now)
    assert [c["hex"] for c in got] == ["502ce3"]
    assert got[0]["flight"] == "BTI34K"


def test_stale_beacon_is_excluded_even_when_airborne():
    now = time.time()
    adsb = Mixed(now, ground_alt=500.0, ground_on_ground=False, ground_fix_age=300.0)
    got = match_event(adsb, SENSOR, {"peak_time": now}, 12000, now=now)
    assert [c["hex"] for c in got] == ["502ce3"]


def test_nearer_airborne_aircraft_still_wins():
    """The filters must not invert genuine ranking."""
    now = time.time()
    adsb = Mixed(now, ground_alt=500.0, ground_on_ground=False)
    got = match_event(adsb, SENSOR, {"peak_time": now}, 12000, now=now)
    assert [c["hex"] for c in got] == ["adstest", "502ce3"]
    assert got[0]["slant_m"] < got[1]["slant_m"]


def test_ground_traffic_can_be_opted_into():
    now = time.time()
    got = match_event(Mixed(now), SENSOR, {"peak_time": now}, 12000,
                      track_ground=True, now=now)
    assert {c["hex"] for c in got} == {"adstest", "502ce3"}


def test_no_candidates_is_honest_rather_than_wrong():
    """With only ground clutter present, the event should match nothing."""
    class OnlyGround(Mixed):
        def snapshot(self):
            return {k: v for k, v in super().snapshot().items() if k == "adstest"}

    now = time.time()
    assert match_event(OnlyGround(now), SENSOR, {"peak_time": now}, 12000, now=now) == []

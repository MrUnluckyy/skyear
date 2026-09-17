import math

import pytest

from skyear.geo import EARTH_R, FT, SPEED_OF_SOUND, bearing_deg, haversine_m, slant

SENSOR = {"lat": 54.6872, "lon": 25.2797, "alt_m": 124.0}
DEG_M = EARTH_R * math.pi / 180  # metres per degree of latitude


def test_one_degree_of_latitude():
    assert haversine_m(0, 0, 1, 0) == pytest.approx(DEG_M, rel=1e-9)
    assert haversine_m(54.0, 25.0, 55.0, 25.0) == pytest.approx(DEG_M, rel=1e-9)


def test_haversine_is_symmetric_and_zero_on_self():
    a, b = (54.6872, 25.2797), (54.7000, 25.3000)
    assert haversine_m(*a, *b) == pytest.approx(haversine_m(*b, *a))
    assert haversine_m(*a, *a) == 0.0


def test_bearing_cardinals():
    assert bearing_deg(0, 0, 1, 0) == pytest.approx(0, abs=1e-6)     # north
    assert bearing_deg(0, 0, 0, 1) == pytest.approx(90, abs=1e-6)    # east
    assert bearing_deg(0, 0, -1, 0) == pytest.approx(180, abs=1e-6)  # south
    assert bearing_deg(0, 1, 0, 0) == pytest.approx(270, abs=1e-6)   # west


def test_slant_is_pythagorean_over_sensor_altitude():
    north = SENSOR["lat"] + 2000 / DEG_M
    s, h, elev, brg = slant(SENSOR, north, SENSOR["lon"], 1000.0)
    dz = 1000.0 - SENSOR["alt_m"]
    assert h == pytest.approx(2000, rel=1e-3)
    assert s == pytest.approx(math.hypot(2000, dz), rel=1e-3)
    assert elev == pytest.approx(math.degrees(math.atan2(dz, 2000)), abs=0.01)
    assert brg == pytest.approx(0, abs=0.01)
    assert s > h  # slant range always exceeds ground range for an airborne target


def test_overhead_aircraft_is_ninety_degrees_elevation():
    s, h, elev, _ = slant(SENSOR, SENSOR["lat"], SENSOR["lon"], 1124.0)
    assert h == pytest.approx(0, abs=1e-6)
    assert elev == pytest.approx(90.0)
    assert s == pytest.approx(1000.0, rel=1e-6)


def test_aircraft_below_sensor_gives_negative_elevation():
    # a hilltop sensor looking down at a low-flying target
    high = {"lat": 54.6872, "lon": 25.2797, "alt_m": 2000.0}
    north = high["lat"] + 3000 / DEG_M
    _, _, elev, _ = slant(high, north, high["lon"], 500.0)
    assert elev < 0


def test_constants_are_sane():
    assert 330 < SPEED_OF_SOUND < 350  # dry air, roughly 0-25 C
    assert FT == 0.3048                # ADS-B altitudes arrive in feet

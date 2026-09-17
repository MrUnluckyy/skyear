"""ADS-B ingestion: unit conversion, track history, and interpolation."""
import time

import pytest

from skyear.adsb import AdsbTracker
from skyear.geo import FT

LAT, LON = 54.6872, 25.2797


def tracker(**kw):
    return AdsbTracker("adsb.lol", LAT, LON, radius_nm=15, **kw)


def payload(now, aircraft):
    return {"now": now, "ac": aircraft}


def plane(hex_id="4ca7b1", lat=LAT, lon=LON, alt_ft=3280.84, seen_pos=0.0, **kw):
    return {"hex": hex_id, "lat": lat, "lon": lon, "alt_geom": alt_ft,
            "seen_pos": seen_pos, "flight": "BTI4TK ", "t": "BCS3", "r": "YL-AAS", **kw}


def test_altitude_is_converted_from_feet_to_metres():
    t = tracker()
    now = time.time()
    t.ingest(payload(now, [plane(alt_ft=3280.84)]))   # 3280.84 ft == 1000 m
    _, (_, _, _, alt_m) = t.snapshot()["4ca7b1"]
    assert alt_m == pytest.approx(3280.84 * FT, rel=1e-9)
    assert alt_m == pytest.approx(1000.0, rel=1e-4)


def test_callsign_is_stripped_and_metadata_captured():
    t = tracker()
    t.ingest(payload(time.time(), [plane()]))
    meta, _ = t.snapshot()["4ca7b1"]
    assert meta["flight"] == "BTI4TK"      # trailing padding removed
    assert meta["type"] == "BCS3"
    assert meta["reg"] == "YL-AAS"
    assert meta["on_ground"] is False


def test_ground_aircraft_are_flagged_and_given_zero_altitude():
    t = tracker()
    p = plane(alt_baro="ground")
    p.pop("alt_geom")
    t.ingest(payload(time.time(), [p]))
    meta, (_, _, _, alt_m) = t.snapshot()["4ca7b1"]
    assert alt_m == 0
    assert meta["on_ground"] is True


def test_aircraft_without_a_position_are_skipped():
    t = tracker()
    t.ingest(payload(time.time(), [{"hex": "abc123", "alt_geom": 1000}]))
    assert t.snapshot() == {}


def test_aircraft_without_an_altitude_are_skipped():
    t = tracker()
    t.ingest(payload(time.time(), [{"hex": "abc123", "lat": LAT, "lon": LON}]))
    assert t.snapshot() == {}


def test_alt_baro_is_used_when_alt_geom_is_absent():
    t = tracker()
    p = plane()
    p.pop("alt_geom")
    p["alt_baro"] = 3280.84
    t.ingest(payload(time.time(), [p]))
    _, (_, _, _, alt_m) = t.snapshot()["4ca7b1"]
    assert alt_m == pytest.approx(1000.0, rel=1e-4)


def test_millisecond_timestamps_are_normalised_to_seconds():
    t = tracker()
    now = time.time()
    t.ingest(payload(now * 1000, [plane()]))
    _, (ts, _, _, _) = t.snapshot()["4ca7b1"]
    assert ts == pytest.approx(now, abs=1)


def test_seen_pos_backdates_the_fix():
    t = tracker()
    now = time.time()
    t.ingest(payload(now, [plane(seen_pos=4.0)]))
    _, (ts, _, _, _) = t.snapshot()["4ca7b1"]
    assert ts == pytest.approx(now - 4.0, abs=0.01)


def test_position_at_interpolates_between_fixes():
    t = tracker()
    now = time.time()
    t.ingest(payload(now, [plane(lat=54.0, lon=25.0)]))
    t.ingest(payload(now + 10, [plane(lat=54.2, lon=25.0)]))

    lat, lon, _ = t.position_at("4ca7b1", now + 5)
    assert lat == pytest.approx(54.1, abs=1e-6)     # halfway
    assert lon == pytest.approx(25.0, abs=1e-6)


def test_position_at_clamps_inside_the_max_gap_and_returns_none_outside():
    t = tracker()
    now = time.time()
    t.ingest(payload(now, [plane(lat=54.0)]))
    assert t.position_at("4ca7b1", now + 5)[0] == pytest.approx(54.0)   # clamped
    assert t.position_at("4ca7b1", now + 600) is None                   # too stale
    assert t.position_at("unknown", now) is None


def test_duplicate_fixes_are_not_appended_twice():
    t = tracker()
    now = time.time()
    for _ in range(5):
        t.ingest(payload(now, [plane()]))
    assert len(t.tracks["4ca7b1"]) == 1


def test_stale_aircraft_are_pruned_from_the_track_store():
    t = tracker(history_s=60)
    t.ingest(payload(time.time() - 3600, [plane(hex_id="old001")]))
    t.ingest(payload(time.time(), [plane(hex_id="new001")]))
    assert "old001" not in t.tracks
    assert "new001" in t.tracks


def test_hex_ids_are_lowercased():
    t = tracker()
    t.ingest(payload(time.time(), [plane(hex_id="4CA7B1")]))
    assert "4ca7b1" in t.snapshot()


def test_provider_url_is_built_for_each_backend():
    assert "/lat/54.6872/lon/25.2797/dist/15" in tracker()._url()
    live = AdsbTracker("airplanes.live", LAT, LON, radius_nm=20)
    assert "/point/54.6872/25.2797/20" in live._url()
    local = AdsbTracker("readsb", LAT, LON, readsb_url="http://pi.local/aircraft.json")
    assert local._url() == "http://pi.local/aircraft.json"

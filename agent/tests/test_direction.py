"""Bearing from several cameras at one address.

The estimate is uncalibrated and cannot point outside the arc the cameras span,
both of which are deliberate and documented. What these tests pin down is that
it is not *arbitrary*: louder pulls the bearing, the wrap at north is handled,
sites are grouped by where the cameras actually are, and every record that ADS-B
explained carries the true bearing beside the estimate - because that pairing is
the whole calibration story.
"""
import pytest

from conftest import SENSOR, m_to_lat, m_to_lon
from skyear.direction import (DirectionTracker, _arc, _signed_diff, group_sites,
                              weighted_bearing)


def cam(cid, north_m=0.0, east_m=0.0, **kw):
    lat = SENSOR["lat"] + m_to_lat(north_m)
    return {"id": cid, "lat": lat, "lon": SENSOR["lon"] + m_to_lon(east_m, lat), **kw}


def event(eid, start, end, snr_db, **kw):
    return {"id": eid, "start": start, "end": end, "snr_db": snr_db, **kw}


# --- which cameras are one site ---------------------------------------------

def test_cameras_on_one_house_are_one_site():
    sites = group_sites([cam("a"), cam("b", north_m=20), cam("c", east_m=15)])
    assert len(set(sites.values())) == 1


def test_cameras_in_different_places_are_different_sites():
    sites = group_sites([cam("a"), cam("b", east_m=4000)])
    assert sites["a"] != sites["b"]


def test_a_chain_of_cameras_still_forms_one_site():
    """Single-link: a and c are 200 m apart but b sits between them."""
    sites = group_sites([cam("a"), cam("c", east_m=200), cam("b", east_m=100)],
                        radius_m=150)
    assert len(set(sites.values())) == 1


def test_an_explicit_site_overrides_the_distance():
    """Two buildings in one yard are one cluster by distance and two sites in
    reality. Only the owner knows which."""
    sites = group_sites([cam("a", site="house"), cam("b", north_m=20, site="barn")])
    assert sites == {"a": "house", "b": "barn"}


# --- turning levels into a bearing -------------------------------------------

def test_one_camera_reports_its_own_direction():
    bearing, conc, arc = weighted_bearing([(270.0, 30.0)])
    assert bearing == 270.0 and arc == 0.0


def test_two_equally_loud_cameras_split_the_difference():
    bearing, _, arc = weighted_bearing([(0.0, 40.0), (90.0, 40.0)])
    assert bearing == 45.0
    assert arc == 90.0


def test_the_louder_camera_pulls_the_bearing_towards_itself():
    quiet, _, _ = weighted_bearing([(0.0, 40.0), (90.0, 40.0)])
    loud, _, _ = weighted_bearing([(0.0, 40.0), (90.0, 34.0)])
    assert loud < quiet, "6 dB down must weigh a quarter, not the same"
    assert 10.0 < loud < 20.0


def test_north_does_not_break_the_average():
    """The failure that averaging degrees naively produces: 350 and 10 give 180,
    pointing exactly backwards."""
    bearing, _, arc = weighted_bearing([(350.0, 40.0), (10.0, 40.0)])
    assert bearing == 0.0
    assert arc == 20.0


def test_nothing_heard_is_not_a_bearing():
    assert weighted_bearing([]) == (None, 0.0, 0.0)


def test_arc_measures_the_span_the_cameras_cover():
    assert _arc([0.0]) == 0.0
    assert _arc([0.0, 90.0]) == 90.0
    assert _arc([350.0, 10.0]) == 20.0
    assert _arc([0.0, 120.0, 240.0]) == 240.0


def test_signed_difference_wraps_the_short_way():
    assert _signed_diff(10.0, 350.0) == 20.0
    assert _signed_diff(350.0, 10.0) == -20.0


# --- joining what several cameras heard --------------------------------------

@pytest.fixture
def tracker():
    out = []
    dt = DirectionTracker(sites={"east": "home", "south": "home", "far": "other"},
                          bearings={"east": 90.0, "south": 180.0, "far": 0.0},
                          on_bearing=out.append, settle_s=8.0, skew_s=3.0)
    return dt, out


def test_two_cameras_hearing_one_sound_make_one_bearing(tracker):
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 42.0))
    dt.add_event("south", event("e2", 1001, 1031, 36.0))   # same sound, quieter
    dt.tick(now=1031 + 9)

    assert len(out) == 1
    rec = out[0]
    assert rec["cameras"] == 2 and rec["site"] == "home"
    assert 90.0 < rec["bearing_deg"] < 135.0, "between the two, nearer the loud one"
    assert [h["camera"] for h in rec["heard"]] == ["east", "south"], "loudest first"


def test_a_group_stays_open_until_the_slower_stream_has_had_its_chance(tracker):
    """RTSP latency differs per camera, so the same sound arrives late on one."""
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 42.0))
    dt.tick(now=1033)
    assert out == [], "closed before the other camera could report"

    dt.add_event("south", event("e2", 1002, 1032, 39.0))
    dt.tick(now=1041)
    assert len(out) == 1 and out[0]["cameras"] == 2


def test_one_camera_alone_is_still_recorded(tracker):
    """A sound only the west-facing camera heard is already information."""
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1010, 30.0))
    dt.tick(now=1019)
    assert len(out) == 1
    assert out[0]["cameras"] == 1 and out[0]["bearing_deg"] == 90.0
    assert out[0]["arc_deg"] == 0.0, "one camera constrains nothing"


def test_separate_sounds_are_separate_bearings(tracker):
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1010, 30.0))
    dt.add_event("east", event("e2", 1100, 1110, 30.0))
    dt.tick(now=1119)
    assert len(out) == 2


def test_wind_gets_no_direction(tracker):
    """Wind is made at the microphone, so its bearing would be the weather's."""
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 42.0, likely_wind=True))
    dt.tick(now=1040)
    assert out == []


def test_a_camera_that_is_not_aimed_takes_no_part(tracker):
    dt, out = tracker
    dt.add_event("unaimed", event("e1", 1000, 1030, 42.0))
    dt.tick(now=1040)
    assert out == []


def test_one_camera_splitting_a_sound_in_two_is_not_counted_twice(tracker):
    """The detector can cut a continuous sound at max_event_s. Two pieces from
    one camera must not vote twice."""
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 36.0))
    dt.add_event("east", event("e2", 1030, 1060, 42.0))
    dt.add_event("south", event("e3", 1001, 1059, 30.0))
    dt.tick(now=1069)
    assert len(out) == 1
    assert out[0]["cameras"] == 2
    east = [h for h in out[0]["heard"] if h["camera"] == "east"]
    assert len(east) == 1 and east[0]["snr_db"] == 42.0, "the louder piece wins"


def test_a_matched_aircraft_leaves_the_answer_beside_the_estimate(tracker):
    """This pairing is the per-site calibration set, and it accumulates without
    anyone doing anything."""
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 42.0),
                 matched={"hex": "4ca7b1", "bearing_deg": 100})
    dt.add_event("south", event("e2", 1001, 1031, 36.0))
    dt.tick(now=1040)

    rec = out[0]
    assert rec["hex"] == "4ca7b1" and rec["true_bearing_deg"] == 100
    assert rec["error_deg"] == round(rec["bearing_deg"] - 100, 1)


def test_an_unexplained_sound_has_no_truth_to_compare(tracker):
    dt, out = tracker
    dt.add_event("east", event("e1", 1000, 1030, 42.0))
    dt.tick(now=1040)
    assert out[0]["true_bearing_deg"] is None and "error_deg" not in out[0]


# --- the wiring the agent actually uses ---------------------------------------

def test_an_agent_with_no_aimed_cameras_does_no_direction_work():
    """Every existing install is this one, and it must cost nothing."""
    from skyear.main import build_direction
    assert build_direction([cam("a"), cam("b", east_m=20)], print) is None


def test_aimed_cameras_at_one_address_produce_a_bearing_end_to_end(tmp_path):
    """From a camera list as the config stores it, through to the record on
    disk - the path nothing else covers."""
    import json

    from skyear.main import JsonlWriter, build_direction

    out = tmp_path / "bearings.jsonl"
    cams = [cam("east", bearing_deg=90), cam("south", north_m=25, bearing_deg=180)]
    dt = build_direction(cams, JsonlWriter(out).write)
    assert dt is not None

    dt.add_event("east", event("e1", 1000, 1030, 44.0),
                 matched={"hex": "4ca7b1", "bearing_deg": 95})
    dt.add_event("south", event("e2", 1001, 1030, 35.0))
    dt.tick(now=1040)

    rec = json.loads(out.read_text().strip())
    assert rec["cameras"] == 2 and rec["site"] == "east"
    assert 90.0 <= rec["bearing_deg"] < 120.0
    assert rec["true_bearing_deg"] == 95 and "error_deg" in rec


def test_an_aimed_camera_alone_still_records(tmp_path, caplog):
    """And says so, because one camera per site cannot be crossed."""
    import logging

    from skyear.main import build_direction

    with caplog.at_level(logging.INFO):
        dt = build_direction([cam("a", bearing_deg=270), cam("b", east_m=4000)], print)
    assert dt is not None
    assert "cannot be crossed" in caplog.text

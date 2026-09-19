"""A second camera must be addable after pairing.

Regression for silent data loss. Sensor rows were created only inside the pair
Edge Function, at pairing time, and:

  - /api/pair refuses once device.json exists ("this agent is already paired")
  - /api/save only wrote local config and never told the cloud
  - ingest could not map an unknown camera_id to a sensor, so it put the event
    in `skipped` and discarded it
  - the uploader ignored `skipped`, so nothing was logged

Meanwhile config.example.yaml advertises `cameras:` as a list and pair accepts
sixteen. A user adding a second camera watched it listen locally and never
appear, with no error anywhere.
"""
import json

import pytest

from skyear import config_store
from skyear.uploader import Uploader


@pytest.fixture
def agent_dir(tmp_path):
    (tmp_path / "events.jsonl").write_text("")
    (tmp_path / "passes.jsonl").write_text("")
    return tmp_path


def test_uploader_declares_its_cameras(agent_dir, monkeypatch):
    """The payload must carry the camera set, or the server cannot converge."""
    sent = {}

    def fake_post(url, payload, token=None, timeout=20.0):
        sent.update(payload)
        return {"ok": True}

    monkeypatch.setattr("skyear.uploader._post", fake_post)
    up = Uploader(
        "https://example.test", "tok", agent_dir,
        live={"home-1": {"level_db": -20}},
        cameras=[
            {"id": "home-1", "lat": 54.6872, "lon": 25.2797, "elevation_m": 100},
            {"id": "home-2", "lat": 54.6880, "lon": 25.2801, "mount_height_m": 6},
        ],
    )
    up.send_once()

    ids = [c["camera_id"] for c in sent["cameras"]]
    assert ids == ["home-1", "home-2"]


def test_declared_positions_are_coarsened(agent_dir, monkeypatch):
    """Invariant 4: the cloud never receives an exact position."""
    sent = {}
    monkeypatch.setattr(
        "skyear.uploader._post",
        lambda url, payload, token=None, timeout=20.0: (sent.update(payload), {"ok": True})[1],
    )
    up = Uploader("https://example.test", "tok", agent_dir,
                  live={"home-1": {}},
                  cameras=[{"id": "home-1", "lat": 54.68724891, "lon": 25.27971234}])
    up.send_once()
    c = sent["cameras"][0]
    assert c["lat"] == 54.687 and c["lon"] == 25.28


def test_camera_without_a_position_is_not_declared(agent_dir, monkeypatch):
    """A half-configured camera must not create a sensor at null island."""
    sent = {}
    monkeypatch.setattr(
        "skyear.uploader._post",
        lambda url, payload, token=None, timeout=20.0: (sent.update(payload), {"ok": True})[1],
    )
    up = Uploader("https://example.test", "tok", agent_dir,
                  live={"home-1": {}},
                  cameras=[{"id": "home-1", "lat": 54.6, "lon": 25.2},
                           {"id": "home-2", "host": "10.0.0.9"}])
    up.send_once()
    assert [c["camera_id"] for c in sent["cameras"]] == ["home-1"]


def test_discards_are_logged(agent_dir, monkeypatch, caplog):
    """A silent discard is how a camera streams into nothing for days."""
    monkeypatch.setattr(
        "skyear.uploader._post",
        lambda *a, **k: {"ok": True, "skipped": ["evt-1", "evt-2"], "registered": ["home-2"]},
    )
    up = Uploader("https://example.test", "tok", agent_dir, live={"home-1": {}})
    with caplog.at_level("INFO", logger="uploader"):
        up.send_once()
    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert "discarded 2" in blob
    assert "home-2" in blob and "registered" in blob


# --- the local config side -------------------------------------------

def test_save_keeps_an_existing_password_when_the_field_is_blank(tmp_path):
    """The password is never sent to the browser, so blank means unchanged."""
    config_store.save(tmp_path, {
        "cameras": [{"id": "home-1", "host": "10.0.0.5", "password_env": "HOME_1_SECRET"}],
        "secrets": {"HOME_1_SECRET": "original"},
    })
    stored = config_store.load(tmp_path)
    assert stored["secrets"]["HOME_1_SECRET"] == "original"


def test_two_cameras_coexist_in_config(tmp_path):
    config_store.save(tmp_path, {
        "cameras": [
            {"id": "home-1", "host": "10.0.0.5"},
            {"id": "home-2", "host": "10.0.0.6"},
        ],
        "secrets": {"HOME_1_SECRET": "a", "HOME_2_SECRET": "b"},
    })
    cams = config_store.load(tmp_path)["cameras"]
    assert sorted(c["id"] for c in cams) == ["home-1", "home-2"]

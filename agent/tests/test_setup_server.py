"""The setup page, which exists so installing a sensor needs no terminal.

The behaviours worth pinning are the security ones: the page is open while
there is nothing to protect, locks once a camera password is stored, and never
hands that password back to a browser.
"""
import json
import threading

import pytest

from skyear import config_store
from skyear.setup_server import probe_camera, serve


@pytest.fixture
def agent(tmp_path):
    live = {}
    httpd = serve(tmp_path, live, port=0, host="127.0.0.1")
    yield tmp_path, live, f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(base, path):
    import urllib.request
    with urllib.request.urlopen(base + path, timeout=10) as r:
        return r.status, json.load(r)


def post(base, path, body):
    import urllib.request
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.load(r)


def http_status(base, path):
    import urllib.error, urllib.request
    try:
        with urllib.request.urlopen(base + path, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


CAMERA = {
    "id": "home-1", "type": "reolink", "host": "192.168.1.50", "username": "admin",
    "lat": 54.652, "lon": 25.341, "elevation_m": 215, "mount_height_m": 4,
}


def test_page_is_served(agent):
    import urllib.request
    _, _, base = agent
    with urllib.request.urlopen(base + "/", timeout=10) as r:
        body = r.read().decode()
    assert "Set up your SkyEar sensor" in body
    assert r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"


def test_open_before_anything_is_configured(agent):
    """A new agent has nothing to protect, and demanding a token from a log
    file would defeat the point of having a setup page at all."""
    _, _, base = agent
    status, state = get(base, "/api/state")
    assert status == 200
    assert state["configured"] is False
    assert state["paired"] is False


def test_locks_once_a_camera_password_is_stored(agent):
    data, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    assert http_status(base, "/api/state") == 403
    token = config_store.setup_token(data)
    assert http_status(base, f"/api/state?t={token}") == 200


def test_password_is_never_returned_to_the_browser(agent):
    data, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    token = config_store.setup_token(data)
    _, state = get(base, f"/api/state?t={token}")
    assert "hunter2" not in json.dumps(state)


def test_saved_config_starts_an_agent(agent):
    """What the wizard writes has to be what the agent can boot from."""
    data, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    stored = config_store.load(data)
    cfg = config_store.to_agent_config(stored)
    assert cfg["cameras"][0]["host"] == "192.168.1.50"
    assert cfg["cameras"][0]["lat"] == 54.652
    # the secret is exposed under the env name the camera config points at
    env_name = cfg["cameras"][0]["password_env"]
    assert config_store.secrets_from(stored)[env_name] == "hunter2"


def test_position_is_required(agent):
    _, _, base = agent
    cam = {k: v for k, v in CAMERA.items() if k not in ("lat", "lon")}
    import urllib.error
    try:
        post(base, "/api/save", {"camera": cam, "secret": "x"})
        raise AssertionError("should have refused")
    except urllib.error.HTTPError as e:
        assert e.code == 400


def test_live_level_is_exposed_for_the_meter(agent):
    data, live, base = agent
    live["home-1"] = {"excess_db": 7.5, "event_active": True, "event_s": 12.0,
                      "rising": False, "warm": True}
    _, state = get(base, "/api/level")
    assert state["live"]["home-1"]["excess_db"] == 7.5
    assert state["live"]["home-1"]["event_active"] is True


def test_probe_reports_a_missing_binary_plainly(monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError()
    monkeypatch.setattr("skyear.setup_server.subprocess.run", boom)
    r = probe_camera(CAMERA, "x")
    assert r["ok"] is False
    assert "ffprobe" in r["error"]


def test_probe_translates_an_auth_failure(monkeypatch):
    class R:
        returncode = 1
        stdout = ""
        stderr = "rtsp://admin:secret@h:554/x: 401 Unauthorized"
    monkeypatch.setattr("skyear.setup_server.subprocess.run", lambda *a, **k: R())
    r = probe_camera(CAMERA, "secret")
    assert "username or password" in r["error"]
    assert "secret" not in r["error"], "the credential must not survive into the message"

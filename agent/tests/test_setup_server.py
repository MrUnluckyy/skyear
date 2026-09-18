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


def test_reading_status_stays_open(agent):
    """Nothing readable is a secret: the password is never returned, and the
    rest is whether a camera exists and what it hears. Locking reads only
    locked people out of their own setup page."""
    _, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    assert http_status(base, "/api/state") == 200


def test_changes_are_locked_once_a_camera_password_is_stored(agent):
    """Reconfiguring or re-pairing is what actually needs protecting."""
    import urllib.error
    data, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    try:
        post(base, "/api/save", {"camera": CAMERA, "secret": "someone-elses"})
        raise AssertionError("a second write should need the token")
    except urllib.error.HTTPError as e:
        assert e.code == 403
    # with the token it goes through
    token = config_store.setup_token(data)
    status, _ = post(base, f"/api/save?t={token}", {"camera": CAMERA, "secret": "mine"})
    assert status == 200


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


def test_saving_returns_a_cookie_that_keeps_the_browser_authorised():
    """Pressing Save used to lock the person who just configured the agent out
    of their own setup page, with the recovery buried inside the container."""
    import urllib.request
    import tempfile
    from pathlib import Path
    from skyear.setup_server import serve

    data = Path(tempfile.mkdtemp())
    httpd = serve(data, {}, port=0, host="127.0.0.1")
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        req = urllib.request.Request(
            base + "/api/save", method="POST",
            data=json.dumps({"camera": CAMERA, "secret": "hunter2"}).encode(),
            headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            cookie = r.headers.get("set-cookie")
        assert cookie and "skyear_setup=" in cookie
        assert "HttpOnly" in cookie and "SameSite=Strict" in cookie

        # that cookie alone gets back in, with no token in the URL
        token = cookie.split("skyear_setup=")[1].split(";")[0]
        req = urllib.request.Request(base + "/api/state",
                                     headers={"cookie": f"skyear_setup={token}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            assert r.status == 200
    finally:
        httpd.shutdown()


def test_the_lock_message_says_how_to_get_back_in(agent):
    import urllib.error
    _, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    try:
        post(base, "/api/save", {"camera": CAMERA, "secret": "again"})
        raise AssertionError("should be locked")
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        assert "setup_token" in body["error"]
        assert "docker exec" in body["error"]


def test_pairing_works_with_no_cloud_url_configured(agent, monkeypatch):
    """An agent from the published image has no config file at all.

    Without a built-in default it could not pair - "camera saved, but pairing
    failed: no cloud url configured" - which made the whole wizard a dead end
    on exactly the install path most people use.
    """
    from skyear import DEFAULT_CLOUD_URL
    import skyear.setup_server as ss

    seen = {}

    def fake_pair(url, code, cameras, name="x"):
        seen["url"] = url
        return {"device_id": "abc", "token": "t", "cameras": [c["id"] for c in cameras]}

    monkeypatch.setattr(ss, "pair", fake_pair)
    data, _, base = agent
    post(base, "/api/save", {"camera": CAMERA, "secret": "hunter2"})
    token = config_store.setup_token(data)
    status, body = post(base, f"/api/pair?t={token}", {"code": "K4M7PQR2"})
    assert status == 200 and body.get("ok")
    assert seen["url"] == DEFAULT_CLOUD_URL
    assert (data / "device.json").is_file()


def test_state_reports_where_it_will_connect(agent):
    from skyear import DEFAULT_CLOUD_URL
    _, _, base = agent
    _, state = get(base, "/api/state")
    assert state["cloud_url"] == DEFAULT_CLOUD_URL


def test_page_uses_relative_api_paths_for_ingress():
    """Home Assistant serves add-ons under /api/hassio_ingress/<token>/.

    An absolute "/api/state" would miss the add-on entirely, so every call has
    to resolve against the page rather than the origin.
    """
    from pathlib import Path
    import skyear

    page = (Path(skyear.__file__).parent / "setup.html").read_text()
    assert "new URL(p, base)" in page, "must resolve against the page, not the origin"
    assert 'api("/api' not in page and "api(`/api" not in page, "no absolute API paths"
    for route in ("api/state", "api/save", "api/pair", "api/test", "api/level"):
        assert route in page


def test_ingress_base_path_tolerates_a_missing_trailing_slash():
    """Relative resolution drops the last segment when the base lacks a
    trailing slash, which would strip the token from an ingress path and send
    every call somewhere harmless and wrong."""
    from pathlib import Path
    import skyear

    page = (Path(skyear.__file__).parent / "setup.html").read_text()
    assert 'document.baseURI.endsWith("/")' in page


def test_pairing_is_not_blocked_by_the_address_bar_update():
    """The URL rewrite used to sit between saving and pairing.

    Inside Home Assistant's ingress iframe it can throw, which saved the camera
    and then silently skipped the pairing call - the user saw an error and no
    sensor ever appeared. It now runs last and cannot abort anything.
    """
    from pathlib import Path
    import skyear

    page = (Path(skyear.__file__).parent / "setup.html").read_text()
    save_at = page.index('api("api/save"')
    pair_at = page.index('api("api/pair"')
    rewrite_at = page.index("history.replaceState")
    assert save_at < pair_at < rewrite_at, "pairing must happen before the URL rewrite"
    # and the rewrite must be inside a try block
    prefix = page[:rewrite_at]
    assert prefix.rindex("try {") > prefix.rindex("const code ="), "rewrite must be guarded"


def test_api_reports_http_failures_rather_than_parse_errors():
    """A non-JSON response must not surface as a browser parse error.

    When something upstream answers with an HTML error page, response.json()
    throws a browser-specific string - Safari's is "The string did not match
    the expected pattern" - which tells the user nothing about what failed.
    """
    from pathlib import Path
    import skyear

    page = (Path(skyear.__file__).parent / "setup.html").read_text()
    assert "JSON.parse(text)" in page, "must parse defensively, not via r.json()"
    assert "r.status" in page and "url.pathname" in page, "must report status and path"
    assert ".then(r => r.json())" not in page, "no unguarded json() left"

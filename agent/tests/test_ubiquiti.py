"""UniFi Protect, which works unlike every other brand supported here.

The stream comes from the NVR rather than the camera, over RTSPS on 7441, and
there is no username or password - a per-camera token in the path IS the
credential. That last part is why redaction matters: masking only user:pass@
would print a working stream key straight into the log.
"""
from skyear.audio import build_url, redact


def test_ubiquiti_url_shape():
    cam = {"id": "gate", "type": "ubiquiti", "host": "192.168.1.1"}
    url = build_url(cam, "abcDEF123456")
    assert url == "rtsps://192.168.1.1:7441/abcDEF123456?enableSrtp"


def test_ubiquiti_port_can_be_overridden():
    cam = {"id": "gate", "type": "ubiquiti", "host": "10.0.0.1", "port": 7447}
    assert build_url(cam, "tok").startswith("rtsps://10.0.0.1:7447/")


def test_ubiquiti_needs_no_username():
    """Protect authenticates by token, so no credentials belong in the URL."""
    url = build_url({"id": "g", "type": "ubiquiti", "host": "h"}, "tok")
    assert "@" not in url
    assert "admin" not in url


def test_ubiquiti_token_is_redacted_from_logs():
    url = build_url({"id": "g", "type": "ubiquiti", "host": "192.168.1.1"}, "s3cretToken123")
    out = redact(url)
    assert "s3cretToken123" not in out
    assert "192.168.1.1" in out, "the useful part should survive"


def test_password_urls_are_still_redacted():
    url = build_url(
        {"id": "c", "type": "reolink", "host": "192.168.1.50", "username": "admin"}, "hunter2"
    )
    out = redact(url)
    assert "hunter2" not in out
    assert "192.168.1.50" in out


def test_a_full_url_can_be_supplied_wholesale():
    """An escape hatch for anything the builders cannot express."""
    cam = {"id": "odd", "url_env": "CAM_URL"}
    assert build_url(cam, "rtsps://nvr:7441/xyz?enableSrtp") == "rtsps://nvr:7441/xyz?enableSrtp"


def test_other_brands_are_unaffected():
    assert build_url({"id": "c", "type": "reolink", "host": "h"}, "p") == (
        "rtsp://admin:p@h:554/Preview_01_sub"
    )
    assert "/Streaming/Channels/102" in build_url({"id": "c", "type": "hikvision", "host": "h"}, "p")


def test_redact_leaves_a_credential_free_url_alone():
    assert redact("rtsp://192.168.1.50:554/Preview_01_sub") == "rtsp://192.168.1.50:554/Preview_01_sub"

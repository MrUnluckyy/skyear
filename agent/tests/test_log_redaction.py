"""Credentials must not reach a log, including through ffmpeg's stderr.

Regression for a real leak. The agent's own log lines redacted correctly
("connecting rtsp://***@192.168.1.88"), but on a reconnect it passed ffmpeg's
stderr through verbatim, and ffmpeg prints the whole URL:

    stream ended (Error opening input file rtsp://admin:PASSWORD@192.168.1.88
    :554/Preview_01_sub. ...), retry in 8s

written to out/agent.log once per reconnect, ten times in one hour.
"""
import io
import logging

import pytest

from skyear.audio import AudioSource, redact, redact_text, url_secret

PW = "n0t-the-real-one.95"
URL = f"rtsp://admin:{PW}@192.168.1.88:554/Preview_01_sub"

# The exact text that leaked.
FFMPEG_ERR = (
    "able\n[in#0 @ 0x151904080] Error opening input: Network is unreachable\n"
    f"Error opening input file {URL}.\n"
    "Error opening input files: Network is unreachable"
)


def test_the_leak_that_happened():
    out = redact_text(FFMPEG_ERR, URL)
    assert PW not in out
    assert "admin" not in out
    assert "192.168.1.88" in out, "the host is diagnostic, keep it"


def test_redacts_without_knowing_the_url():
    """The pattern has to work on text alone - callers may not have the URL."""
    out = redact_text(FFMPEG_ERR)
    assert PW not in out


def test_percent_encoded_password():
    """build_url percent-encodes, so ffmpeg may echo the encoded form."""
    pw = "p@ss/word+1"
    url = "rtsp://admin:p%40ss%2Fword%2B1@10.0.0.5:554/s"
    assert pw not in redact_text(f"Error opening input file {url}.", url)
    assert "p%40ss%2Fword%2B1" not in redact_text(f"failed: {url}", url)


def test_unifi_path_token():
    """rtsps hides the credential in the path, with no '@' to key on."""
    url = "rtsps://192.168.1.1:7441/abcd1234TOKEN?enableSrtp"
    out = redact_text(f"Error opening input file {url}.", url)
    assert "abcd1234TOKEN" not in out


def test_url_secret_extraction():
    assert url_secret(URL) == PW
    assert url_secret("rtsps://host:7441/TOK?x") == "TOK"
    assert url_secret("rtsp://host:554/path") == ""
    assert url_secret("not a url") == ""


def test_multiple_urls_in_one_blob():
    text = f"first {URL} then rtsp://bob:hunter2@10.1.1.1:554/x done"
    out = redact_text(text, URL)
    assert PW not in out and "hunter2" not in out


def test_plain_redact_still_handles_a_bare_url():
    assert redact(URL) == "rtsp://***@192.168.1.88:554/Preview_01_sub"


class _FakeProc:
    """Enough of Popen for the failure path. No network, no ffmpeg."""

    def __init__(self, err: bytes):
        self.stdout = io.BytesIO(b"")
        self.stderr = io.BytesIO(err)
        self.returncode = 1

    def kill(self):
        pass

    def wait(self):
        return 1


def test_no_credentials_reach_the_logger(monkeypatch, caplog):
    """Drive the real logging path with a fake ffmpeg that prints the URL.

    Deliberately not a live call. An earlier version of this test pointed a
    real ffmpeg at the camera address and hung for the connection timeout.
    """
    monkeypatch.setattr(
        "skyear.audio.subprocess.Popen",
        lambda *a, **k: _FakeProc(FFMPEG_ERR.encode()),
    )
    src = AudioSource(URL, live=False)
    with caplog.at_level(logging.DEBUG, logger="audio"):
        list(src.chunks())

    # getMessage() already applies the args; formatting again double-applies.
    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert PW not in blob, blob
    assert "admin:" not in blob, blob


def test_truncation_cannot_expose_a_fragment():
    """Redact before slicing.

    Truncating first can cut a URL so the pattern no longer matches while part
    of the password survives - the ordering bug this test exists to pin.
    """
    padding = "x" * 500
    text = f"{padding} Error opening input file {URL}. trailing"
    # The order the code uses.
    assert PW not in redact_text(text, URL)[-200:]
    # The order it must not use, shown failing, so the test is meaningful.
    naive = text[-200:]
    assert PW in naive, "precondition: a naive slice would keep the password"

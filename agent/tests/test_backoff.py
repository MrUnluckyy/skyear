"""Backoff for the free ADS-B APIs.

Retrying a 429 at the normal poll rate is what gets a community API to ban an
IP, so failures must back off and a Retry-After header must be honoured.
"""
import urllib.error

import pytest

from skyear.adsb import AdsbTracker

LAT, LON = 54.6872, 25.2797


def tracker(**kw):
    return AdsbTracker("adsb.lol", LAT, LON, poll_s=5.0, **kw)


def http_error(status=429, headers=None):
    return urllib.error.HTTPError("http://x", status, "Too Many Requests", headers or {}, None)


def test_healthy_polling_uses_the_configured_interval():
    assert tracker().next_delay(fails=0) == 5.0


def test_delay_grows_exponentially_with_consecutive_failures():
    t = tracker()
    delays = [t.next_delay(fails=n) for n in range(1, 6)]
    assert delays == [10.0, 20.0, 40.0, 80.0, 160.0]
    assert delays == sorted(delays), "backoff must be monotonic"


def test_backoff_is_capped():
    t = tracker(max_backoff_s=60.0)
    assert t.next_delay(fails=99) == 60.0


def test_retry_after_header_wins_over_exponential_backoff():
    t = tracker()
    assert t.next_delay(fails=1, retry_after=45.0) == 45.0
    # even when exponential backoff would have waited longer
    assert t.next_delay(fails=8, retry_after=30.0) == 30.0


def test_retry_after_is_clamped_to_sane_bounds():
    t = tracker(max_backoff_s=120.0)
    assert t.next_delay(fails=1, retry_after=0.0) == 5.0      # never faster than poll_s
    assert t.next_delay(fails=1, retry_after=9999.0) == 120.0  # never longer than the cap


def test_retry_after_is_parsed_from_the_http_error():
    assert AdsbTracker.retry_after_seconds(http_error(headers={"Retry-After": "30"})) == 30.0
    assert AdsbTracker.retry_after_seconds(http_error(headers={"Retry-After": " 12 "})) == 12.0


def test_missing_or_unparsable_retry_after_falls_back_to_backoff():
    assert AdsbTracker.retry_after_seconds(http_error()) is None
    assert AdsbTracker.retry_after_seconds(
        http_error(headers={"Retry-After": "Wed, 17 Sep 2026 14:30:00 GMT"})) is None
    assert AdsbTracker.retry_after_seconds(ValueError("not an http error")) is None


def test_run_backs_off_then_recovers(monkeypatch):
    """A 429 storm must not keep polling at the normal rate."""
    import threading

    t = tracker()
    calls = {"n": 0}
    waits = []

    def flaky():
        calls["n"] += 1
        if calls["n"] <= 3:
            raise http_error()

    stop = threading.Event()

    class FakeStop:
        def is_set(self):
            return len(waits) >= 5

        def wait(self, d):
            waits.append(d)

    monkeypatch.setattr(t, "poll_once", flaky)
    t.run(FakeStop())

    assert waits[:3] == [10.0, 20.0, 40.0]   # backing off while failing
    assert waits[3] == 5.0                    # back to normal once it recovers
    assert calls["n"] >= 4

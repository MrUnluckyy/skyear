"""Backoff and provider rotation for the free ADS-B APIs.

Measured 2026-09-23 from one client at a 10 s poll, 48 requests each: adsb.lol
returned 429 for 8 of them, adsb.fi for none. That is the provider shedding
load - we were two orders of magnitude under its burst limit - and neither API
sends Retry-After. So the first answer to a shed request is to rotate to the
other provider, not to sit out a backoff: a blind window costs aircraft passes,
and passes are the whole dataset. Backing off is what happens once *every*
provider has failed, because retrying at the normal rate is what gets a
community API to ban an IP.
"""
import urllib.error

import pytest

from skyear.adsb import AdsbTracker

LAT, LON = 54.6872, 25.2797


def tracker(provider="adsb.lol", **kw):
    return AdsbTracker(provider, LAT, LON, poll_s=5.0, **kw)


def pinned(**kw):
    """One provider only, so the pure backoff ladder is observable."""
    return tracker(provider=["adsb.lol"], **kw)


def http_error(status=429, headers=None):
    return urllib.error.HTTPError("http://x", status, "Too Many Requests", headers or {}, None)


class FakeStop:
    """Stops the run loop after a fixed number of waits, recording each one."""

    def __init__(self, after):
        self.after, self.waits = after, []

    def is_set(self):
        return len(self.waits) >= self.after

    def wait(self, d):
        self.waits.append(d)


# --- choosing the providers -------------------------------------------------

def test_a_named_provider_keeps_the_others_as_fallbacks():
    """A config naming one API is a preference, not an exclusive choice."""
    assert tracker("adsb.lol").providers == ["adsb.lol", "adsb.fi"]
    assert tracker("adsb.fi").providers == ["adsb.fi", "adsb.lol"]


def test_a_list_pins_the_rotation_exactly():
    assert tracker(["adsb.fi"]).providers == ["adsb.fi"]
    assert tracker(["adsb.lol", "adsb.fi"]).providers == ["adsb.lol", "adsb.fi"]


def test_a_local_receiver_never_falls_back_to_a_public_api():
    """An operator who put up an antenna expects their own receiver, not a
    silent switch to a public feed with different provenance."""
    assert tracker("readsb", readsb_url="http://pi/data.json").providers == ["readsb"]


def test_an_unknown_provider_is_rejected_at_startup():
    with pytest.raises(ValueError, match="adsb.lel"):
        tracker("adsb.lel")


# --- the backoff ladder -----------------------------------------------------

def test_healthy_polling_uses_the_configured_interval():
    assert pinned().next_delay(fails=0) == 5.0


def test_delay_grows_exponentially_with_consecutive_failures():
    t = pinned()
    delays = [t.next_delay(fails=n) for n in range(1, 6)]
    assert delays == [10.0, 20.0, 40.0, 80.0, 160.0]
    assert delays == sorted(delays), "backoff must be monotonic"


def test_backoff_is_capped():
    t = pinned(max_backoff_s=60.0)
    assert t.next_delay(fails=99) == 60.0


def test_a_429_clears_sooner_than_a_dead_network():
    """The two failures are not alike. Load shedding is over in seconds, so
    waiting out the network cap after one blinds us through passes we could
    have recorded; a genuinely dead network earns the long wait."""
    t = pinned(max_backoff_s=300.0, rate_limit_backoff_s=60.0)
    assert t.next_delay(fails=6, rate_limited=True) == 60.0
    assert t.next_delay(fails=6, rate_limited=False) == 300.0


def test_switching_provider_costs_a_pause_not_a_backoff():
    t = tracker()
    assert t.next_delay(fails=4, rate_limited=True, switching=True) == 1.0


def test_retry_after_header_wins_over_exponential_backoff():
    t = pinned()
    assert t.next_delay(fails=1, retry_after=45.0) == 45.0
    # even when exponential backoff would have waited longer
    assert t.next_delay(fails=8, retry_after=30.0) == 30.0


def test_retry_after_is_clamped_to_sane_bounds():
    t = pinned(max_backoff_s=120.0)
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


def test_only_a_429_counts_as_rate_limiting():
    assert AdsbTracker.is_rate_limited(http_error(429))
    assert not AdsbTracker.is_rate_limited(http_error(503))
    assert not AdsbTracker.is_rate_limited(OSError("connection refused"))


# --- rotation ---------------------------------------------------------------

def test_rotate_prefers_a_provider_that_has_not_failed_yet():
    t = tracker(["adsb.lol", "adsb.fi"])
    t.tried.add("adsb.lol")
    assert t.rotate() is True
    assert t.provider == "adsb.fi"


def test_rotate_reports_exhaustion_once_every_provider_has_failed():
    t = tracker(["adsb.lol", "adsb.fi"])
    t.tried.update(["adsb.lol", "adsb.fi"])
    assert t.rotate() is False
    assert t.tried == set(), "the next round must be free to try them all again"


def test_a_single_provider_has_nowhere_to_rotate():
    t = pinned()
    t.tried.add("adsb.lol")
    assert t.rotate() is False


# --- the run loop -----------------------------------------------------------

def test_one_provider_backs_off_then_recovers(monkeypatch):
    """With nowhere to switch, a 429 storm must not keep polling at the normal rate."""
    t = pinned()
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] <= 3:
            raise http_error()

    stop = FakeStop(after=5)
    monkeypatch.setattr(t, "poll_once", flaky)
    t.run(stop)

    assert stop.waits[:3] == [10.0, 20.0, 40.0]   # backing off while failing
    assert stop.waits[3] == 5.0                    # back to normal once it recovers
    assert calls["n"] >= 4


def test_a_shedding_provider_costs_a_switch_not_a_blind_window(monkeypatch):
    """The point of the rotation: one shed request stops being a 10 s hole in
    the track history and becomes a one second pause."""
    t = tracker(["adsb.lol", "adsb.fi"])
    seen = []

    def shedding():
        seen.append(t.provider)
        if t.provider == "adsb.lol":
            raise http_error()

    stop = FakeStop(after=3)
    monkeypatch.setattr(t, "poll_once", shedding)
    t.run(stop)

    assert seen[:2] == ["adsb.lol", "adsb.fi"]
    assert stop.waits[0] == 1.0, "switched rather than waited out the backoff"
    assert stop.waits[1] == 5.0, "and resumed the normal interval"
    assert t.provider == "adsb.fi", "sticks with the one that answers"


def test_backoff_only_once_both_providers_have_shed(monkeypatch):
    t = tracker(["adsb.lol", "adsb.fi"])

    def dead():
        raise http_error()

    stop = FakeStop(after=4)
    monkeypatch.setattr(t, "poll_once", dead)
    t.run(stop)

    # switch, then both are exhausted so back off, then switch again. The
    # fourth wait is the 429 cap, not 5 x 2^4 = 80 s.
    assert stop.waits == [1.0, 20.0, 1.0, 60.0]


# --- knowing when we are blind ----------------------------------------------

def test_blind_for_counts_from_startup_before_the_first_poll():
    t = tracker()
    t.started_at = 1000.0
    assert t.blind_for(now=1120.0) == 120.0


def test_blind_for_counts_from_the_last_successful_poll():
    t = tracker()
    t.started_at, t.last_ok = 1000.0, 1100.0
    assert t.blind_for(now=1160.0) == 60.0

"""Wind rejection.

Found on the first live run: two events at 38-40 dB SNR, dominant frequency
pinned at 56-57 Hz against the band edge, energy falling ~39 dB from the
50-100 Hz band to everything above 400 Hz - while real A220s on approach went
undetected. Wind that coincides with an aircraft pass would mark it heard and
inflate the detection rate the project is judged on.
"""
import numpy as np

from skyear.detector import BandEnergyDetector
from test_detector import SR, engine, feed, quiet


def wind(seconds, rng, sr=SR, amp=0.3, slope=2.5, knee=45.0):
    """Mic buffeting: noise shaped to roll off steeply above a low knee.

    slope=2.5 was calibrated against the two gusts recorded live on 2026-09-17
    and reproduces them closely - tilt 26.9 dB, dominant 54 Hz, SNR 41.2, versus
    the observed 24-25 dB, 56-57 Hz, 38-40 dB.
    """
    n = int(seconds * sr)
    f = np.fft.rfftfreq(n, 1 / sr)
    spec = rng.normal(0, 1, len(f)) + 1j * rng.normal(0, 1, len(f))
    spec *= 1.0 / (1.0 + (np.maximum(f, 1e-6) / knee) ** slope)
    sig = np.fft.irfft(spec, n)
    sig = sig / (np.abs(sig).max() + 1e-12) * amp
    env = np.sin(np.pi * np.linspace(0, 1, n)) ** 0.5
    return sig * env + rng.normal(0, 5e-4, n)


def test_wind_gust_is_tagged_and_measured():
    rng = np.random.default_rng(17)
    sig = np.concatenate([quiet(60, rng), wind(20, rng), quiet(20, rng)])
    events = feed(BandEnergyDetector(sr=SR), sig)

    assert events, "the gust should still be recorded as an event"
    ev = events[0]
    assert ev["likely_wind"] is True
    assert ev["low_tilt_db"] >= 20.0
    assert ev["octave_db"]["50-100"] > ev["octave_db"]["200-400"]


def test_engine_pass_is_not_tagged_as_wind():
    """The guard must not suppress the signal the project exists to find."""
    rng = np.random.default_rng(1234)
    sig = np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]

    assert ev["likely_wind"] is False
    assert ev["low_tilt_db"] < 20.0


def test_tilt_threshold_is_configurable():
    rng = np.random.default_rng(17)
    sig = np.concatenate([quiet(60, rng), wind(20, rng), quiet(20, rng)])

    strict = feed(BandEnergyDetector(sr=SR, wind_tilt_db=5.0), sig)[0]
    lenient = feed(BandEnergyDetector(sr=SR, wind_tilt_db=100.0), sig)[0]
    assert strict["likely_wind"] is True
    assert lenient["likely_wind"] is False


def test_every_event_carries_the_tilt_fields():
    """Downstream code and the ingest schema rely on these always being present."""
    rng = np.random.default_rng(1234)
    sig = np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]
    assert "low_tilt_db" in ev and "likely_wind" in ev
    assert isinstance(ev["likely_wind"], bool)


def test_wind_and_engine_are_separated_by_a_wide_margin():
    """A narrow margin would make the threshold fragile across sites."""
    rng = np.random.default_rng(17)
    gust = feed(BandEnergyDetector(sr=SR),
                np.concatenate([quiet(60, rng), wind(20, rng), quiet(20, rng)]))[0]
    rng = np.random.default_rng(1234)
    pas = feed(BandEnergyDetector(sr=SR),
               np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)]))[0]
    assert gust["low_tilt_db"] - pas["low_tilt_db"] > 40


def test_observed_live_values_classify_correctly():
    """Reproduces the two real gusts recorded at 11:27 and 11:31 on 2026-09-17."""
    det = BandEnergyDetector(sr=SR)
    for low, mid in ((20.5, -4.3), (21.8, -2.2)):
        assert (low - mid) >= det.wind_tilt_db

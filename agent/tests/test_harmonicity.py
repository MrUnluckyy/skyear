"""Periodicity as the drone feature.

Wind is broadband and aperiodic. A piston drone is a dense harmonic stack, which
is what cepstral peak prominence is good at - including when the engine is
quieter than the wind covering it.

The honest limit is tested too: a jet is mostly broadband roar with few strong
harmonics, so this feature barely moves for one. It is a drone detector, not an
aircraft detector, and the tests say so.
"""
import numpy as np
import pytest

from skyear.detector import BandEnergyDetector
from test_detector import SR, engine, feed, quiet
from test_wind import wind


def piston(seconds, rng, f0=105.0, amp=0.05, harmonics=12, sr=SR):
    """A two-stroke driving a propeller: many harmonics of a low fundamental."""
    t = np.arange(int(seconds * sr)) / sr
    sig = sum((amp / (k ** 0.5)) * np.sin(2 * np.pi * f0 * k * t) for k in range(1, harmonics + 1))
    return sig + rng.normal(0, 5e-4, len(t))


def median_cpp(det, sig):
    n = det.n
    vals = [det._cpp(np.abs(np.fft.rfft(sig[i:i + n] * det.win)) ** 2 + 1e-20)[0]
            for i in range(0, len(sig) - n, n)]
    return float(np.median(vals))


def test_piston_reads_as_periodic_and_noise_does_not():
    det = BandEnergyDetector(sr=SR)
    rng = np.random.default_rng(3)
    assert median_cpp(det, piston(12, rng)) > det.harmonic_cpp_db
    assert median_cpp(det, wind(12, rng)) < det.harmonic_cpp_db
    assert median_cpp(det, rng.normal(0, 0.05, 12 * SR)) < det.harmonic_cpp_db


def test_piston_survives_being_quieter_than_the_wind():
    """The case that matters: a drone under a gale."""
    det = BandEnergyDetector(sr=SR)
    rng = np.random.default_rng(3)
    w = wind(12, rng, amp=0.3)
    p = piston(12, rng)
    scale = (np.std(w) / np.std(p)) * (10 ** (-6 / 20))  # 6 dB below the wind
    assert median_cpp(det, p * scale + w) > det.harmonic_cpp_db


def test_fundamental_is_recovered():
    det = BandEnergyDetector(sr=SR)
    rng = np.random.default_rng(3)
    n = det.n
    sig = piston(6, rng, f0=105.0)
    f0s = [det._cpp(np.abs(np.fft.rfft(sig[i:i + n] * det.win)) ** 2 + 1e-20)[1]
           for i in range(0, len(sig) - n, n)]
    assert np.median(f0s) == pytest.approx(105, rel=0.08)


def test_events_carry_the_periodicity_fields():
    rng = np.random.default_rng(3)
    sig = np.concatenate([quiet(60, rng), piston(30, rng), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]
    assert ev["harmonic"] is True
    assert ev["cpp_db"] > 0
    assert 80 < ev["f0_hz"] < 140


def test_a_harmonic_source_is_never_discarded_as_wind():
    """A real B738 pass was thrown away as wind by the tilt test alone.

    Wind now requires low tilt AND aperiodicity, so anything with engine-like
    structure survives even when its spectrum tilts low - which is what distant
    aircraft do, because the atmosphere absorbs their high frequencies.
    """
    rng = np.random.default_rng(3)
    sig = np.concatenate([quiet(60, rng), piston(30, rng, amp=0.09), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]
    assert ev["harmonic"] is True
    assert ev["likely_wind"] is False


def test_wind_is_still_rejected():
    rng = np.random.default_rng(17)
    sig = np.concatenate([quiet(60, rng), wind(20, rng), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]
    assert ev["harmonic"] is False
    assert ev["likely_wind"] is True


def test_the_feature_is_weak_for_jets_and_that_is_documented():
    """Guards the limitation, so nobody later assumes this detects aircraft."""
    det = BandEnergyDetector(sr=SR)
    rng = np.random.default_rng(1234)
    jet = median_cpp(det, engine(12, rng, ramp=False))
    noise = median_cpp(det, rng.normal(0, 0.05, 12 * SR))
    assert jet < det.harmonic_cpp_db, "a few tones do not make a cepstral peak"
    assert jet - noise < 0.05, "and the margin over noise is small"

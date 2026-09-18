"""Tests for the narrowband rotor feature.

Two of these are regression tests for bugs found while building it, and both
were the kind that make a detector look like it works:

  - harmonics were probed at bin m*lag, but the whitened spectrum is indexed
    from BAND_LO_HZ, so every harmonic was looked for 40 Hz too high. A
    synthetic two-stroke with twelve harmonics reported zero.
  - the synthesiser used sin(2*pi*f(t)*t), whose instantaneous frequency is
    f(t) + t*f'(t). A 0.6 Hz "jitter" became a 35 Hz chirp over 30 s, smeared
    the synthetic scooter across 60 Hz, and produced a perfect drone/scooter
    AUC that was measuring nothing but my own bug.
"""
import numpy as np
import pytest

from skyear.rotor import comb, welch_spectrum

SR = 16000


def stack(f0, n_harm, seconds=20.0, rolloff_db=3.0, amp=1.0, sr=SR):
    """A clean harmonic stack with correctly integrated phase."""
    t = np.arange(int(seconds * sr)) / sr
    out = np.zeros_like(t)
    for m in range(1, n_harm + 1):
        out += 10 ** (-rolloff_db * (m - 1) / 20.0) * np.sin(2 * np.pi * f0 * m * t)
    return (amp * out / (np.std(out) + 1e-9)).astype(np.float32)


def noise(seconds=20.0, sr=SR, seed=0):
    return np.random.default_rng(seed).normal(0, 1, int(seconds * sr)).astype(np.float32)


def test_finds_the_fundamental_spacing():
    r = comb(stack(100.0, 10), SR)
    assert r["f0_hz"] == pytest.approx(100.0, abs=3.0)
    assert r["comb_db"] > 6.0


def test_counts_harmonics_at_the_right_frequencies():
    """Regression: harmonics were probed 40 Hz high, giving 0 for a full stack."""
    r = comb(stack(105.0, 12), SR)
    # Twelve are synthesised; the top few fall below the 3 dB criterion as the
    # rolloff takes them down, so require most rather than all.
    assert r["n_harmonics"] >= 8, r


def test_broadband_noise_has_no_comb():
    r = comb(noise(), SR)
    assert r["n_harmonics"] == 0
    assert r["tonal_db"] < 0.3


def test_wind_shaped_noise_has_no_comb():
    """The most common false positive on this site must score zero harmonics."""
    n = noise(seed=4)
    b = np.fft.rfft(n)
    f = np.fft.rfftfreq(len(n), 1 / SR)
    b *= 1.0 / (1.0 + (f / 70.0) ** 2.0)
    wind = np.fft.irfft(b, len(n)).astype(np.float32)
    r = comb(wind, SR)
    assert r["n_harmonics"] == 0, r


def test_survives_negative_snr():
    """A tonal source buried under noise is the whole point of integrating."""
    sig = stack(92.0, 10, seconds=30.0)
    buried = (sig * 10 ** (-6 / 20.0) + noise(30.0, seed=7)).astype(np.float32)
    r = comb(buried, SR)
    assert r["f0_hz"] == pytest.approx(92.0, abs=4.0)
    assert r["n_harmonics"] >= 4, r


def test_integrated_phase_stays_narrowband():
    """Regression: sin(2*pi*f(t)*t) chirps instead of wobbling.

    Build a jittered stack the correct way and assert the fundamental is still
    confined to a few bins. The buggy form spread it over 60 Hz.
    """
    seconds, f0, jitter = 30.0, 105.0, 0.006
    t = np.arange(int(seconds * SR)) / SR
    inst = f0 * (1.0 + jitter * np.sin(2 * np.pi * 0.3 * t))
    sig = np.sin(2 * np.pi * np.cumsum(inst) / SR).astype(np.float32)

    freqs, power = welch_spectrum(sig, SR)
    db = 10 * np.log10(power + 1e-20)
    peak = int(np.argmax(db))
    # 20 dB down within 5 bins (~10 Hz) of the peak, both sides.
    assert db[peak] - db[peak + 5] > 20, db[peak] - db[peak + 5]
    assert db[peak] - db[peak - 5] > 20


def test_short_input_is_not_scored():
    r = comb(np.zeros(100, dtype=np.float32), SR)
    assert r == {"comb_db": 0.0, "f0_hz": 0.0, "n_harmonics": 0, "tonal_db": 0.0}


def test_silence_does_not_crash():
    r = comb(np.zeros(SR * 5, dtype=np.float32), SR)
    assert r["n_harmonics"] == 0


def test_detector_reports_rotor_fields():
    """The feature has to actually reach the event dict."""
    from skyear.detector import BandEnergyDetector

    d = BandEnergyDetector(sr=SR, warmup_s=1.0, min_duration_s=2.0, release_s=1.0)
    quiet = noise(seconds=1.0, seed=1) * 0.001
    loud = stack(110.0, 10, seconds=12.0, amp=0.5)

    events = []
    t = 0.0
    for chunk in (quiet, quiet, quiet, loud, quiet, quiet, quiet, quiet):
        events += d.process(t, chunk)
        t += len(chunk) / SR

    assert events, "expected the stack to raise an event"
    e = events[0]
    assert "comb_db" in e and "n_harmonics" in e and "comb_f0_hz" in e
    assert e["comb_f0_hz"] == pytest.approx(110.0, abs=6.0), e

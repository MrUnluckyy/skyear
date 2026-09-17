"""Detector behaviour: catch a sustained engine pass, ignore everything short.

Mirrors the sandbox checks recorded in HANDOVER.md so they stay verified.
"""
import numpy as np
import pytest

from skyear.detector import OCTAVES, BandEnergyDetector

SR = 16000
CHUNK = 0.25


def feed(det, signal, sr=SR, t0=1000.0):
    """Push a signal through the detector in realistic 0.25 s chunks."""
    events = []
    n = int(sr * CHUNK)
    for i in range(0, len(signal) - n + 1, n):
        t = t0 + i / sr
        events.extend(det.process(t, signal[i:i + n].astype(np.float32)))
    return events


def quiet(seconds, rng, sr=SR, level=5e-4):
    return rng.normal(0, level, int(seconds * sr))


def engine(seconds, rng, sr=SR, f0=118.0, amp=0.03, ramp=True):
    """Low-frequency tone with harmonics, optionally with a pass envelope."""
    t = np.arange(int(seconds * sr)) / sr
    sig = sum(amp / (k ** 0.7) * np.sin(2 * np.pi * f0 * k * t) for k in (1, 2, 3))
    if ramp:
        env = np.sin(np.pi * np.linspace(0, 1, len(t))) ** 0.5  # rise and fall
        sig = sig * env
    return sig + rng.normal(0, 5e-4, len(t))


def test_detects_a_sustained_engine_pass():
    rng = np.random.default_rng(1234)
    sig = np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)])
    events = feed(BandEnergyDetector(sr=SR), sig)

    assert len(events) == 1, f"expected one pass, got {len(events)}"
    ev = events[0]
    assert ev["duration_s"] >= 4.0
    assert ev["snr_db"] > 8.0
    assert 90 < ev["dominant_hz"] < 260      # fundamental or its first harmonic
    assert ev["peak_db"] > ev["floor_db"]
    assert ev["end"] > ev["start"]


def test_event_carries_octave_band_features_for_training():
    rng = np.random.default_rng(99)
    sig = np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)])
    ev = feed(BandEnergyDetector(sr=SR), sig)[0]

    assert set(ev["octave_db"]) == {f"{lo}-{hi}" for lo, hi in OCTAVES}
    assert all(isinstance(v, float) for v in ev["octave_db"].values())
    # a low-frequency engine must be loudest in the bottom bands
    assert ev["octave_db"]["100-200"] > ev["octave_db"]["1600-3200"]


def test_ignores_a_one_second_click():
    rng = np.random.default_rng(7)
    click = np.zeros(SR)
    click[:SR // 2] = rng.normal(0, 0.2, SR // 2)     # 0.5 s of loud broadband
    sig = np.concatenate([quiet(60, rng), click, quiet(20, rng)])

    assert feed(BandEnergyDetector(sr=SR), sig) == []


def test_ignores_repeated_short_transients():
    """Doors, dogs and claps must not accumulate into an event."""
    rng = np.random.default_rng(21)
    parts = [quiet(60, rng)]
    for _ in range(6):
        bang = rng.normal(0, 0.15, int(0.6 * SR))
        parts += [bang, quiet(4, rng)]
    assert feed(BandEnergyDetector(sr=SR), np.concatenate(parts)) == []


def test_steady_hum_is_absorbed_into_the_noise_floor():
    """A constant 100 Hz mains hum must not read as a permanent detection."""
    rng = np.random.default_rng(5)
    hum = engine(120, rng, f0=100.0, amp=0.02, ramp=False)
    assert feed(BandEnergyDetector(sr=SR), hum) == []


def test_nothing_triggers_during_warmup():
    rng = np.random.default_rng(3)
    det = BandEnergyDetector(sr=SR, warmup_s=60.0)
    sig = np.concatenate([quiet(5, rng), engine(40, rng, ramp=False), quiet(10, rng)])
    assert feed(det, sig) == []


def test_long_events_are_capped_at_max_event_s():
    rng = np.random.default_rng(11)
    det = BandEnergyDetector(sr=SR, max_event_s=20.0)
    sig = np.concatenate([quiet(60, rng), engine(90, rng, ramp=False), quiet(10, rng)])
    events = feed(det, sig)
    assert events, "a long steady source should still produce events"
    assert all(ev["duration_s"] <= 20.5 for ev in events)


def test_frame_accounting_survives_chunk_boundaries():
    """Chunks are 0.25 s but frames are 0.5 s; timestamps must stay monotonic."""
    rng = np.random.default_rng(42)
    det = BandEnergyDetector(sr=SR)
    sig = np.concatenate([quiet(60, rng), engine(30, rng), quiet(20, rng)])
    ev = feed(det, sig, t0=1000.0)[0]
    assert 1000.0 <= ev["start"] < ev["peak_time"] + 0.5
    assert ev["peak_time"] <= ev["end"]
    assert ev["duration_s"] == pytest.approx(ev["end"] - ev["start"], abs=0.1)

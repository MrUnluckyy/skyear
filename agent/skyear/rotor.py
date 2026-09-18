"""Narrowband rotor signature: the harmonic comb a propeller leaves.

WHY A NEW FEATURE

The detector's existing features cannot see a propeller, and it is worth being
precise about why, because it looks like they should.

`octave_db` has six bands, each an octave wide. A quadcopter at 6000 RPM with
two blades puts tones at 200, 400, 600, 800 Hz. Those four tones land in two
octave bands, and inside a band there is one number. The comb is not attenuated
by the octave analysis - it is invisible to it.

`cpp_db` (cepstral peak prominence) is the right idea and fails in practice.
Measured on this site: a DA42 at 2.9 km scores 0.066 and a C150 at 9.3 km
scores 0.077, against a noise floor of 0.052 and a threshold of 0.12 calibrated
on synthesis at 0.228. Real propellers at real distances do not reach it,
because it is computed per 0.5 s frame at 8000 quefrency bins over the whole
band, so a handful of surviving harmonics are diluted by everything else.

WHAT THIS DOES INSTEAD

Tones survive averaging; noise does not. So:

1. Welch-average the power spectrum over the whole event, not per frame. Every
   doubling of integration time buys ~1.5 dB on a stationary tone against
   Gaussian noise. A 60 s event at 0.5 s hops is ~120 averages.
2. Whiten: subtract a median-filtered copy of the spectrum. Median filtering
   over ~60 Hz removes broadband shape - wind tilt, road rumble, the
   atmosphere's low-pass - and leaves only what is narrow.
3. Autocorrelate the whitened spectrum along the frequency axis. A harmonic
   stack repeats every f0 Hz, so it produces a peak at lag f0 whether or not
   the fundamental itself is present. This is the step that survives distance:
   air absorption removes the top of the stack but the spacing of what remains
   is unchanged.
4. Count how many multiples of that spacing actually carry energy.

WHAT IT CANNOT DO

It cannot tell a Shahed from a scooter. Both are small two-stroke engines
driving a propeller or wheel, both produce a harmonic stack with a fundamental
in the same 50-150 Hz range. Anyone who claims a single microphone separates
them on spectrum alone is guessing. Separation has to come from elsewhere -
altitude, persistence, and whether several sensors hear it at once - and this
module deliberately reports measurements rather than a verdict.
"""
from __future__ import annotations

import numpy as np

# A propeller or small engine fundamental. Below 40 Hz is building plant and
# road rumble; above 300 Hz the spacing is too fine to resolve reliably at the
# distances this project cares about.
F0_MIN_HZ, F0_MAX_HZ = 40.0, 300.0

# Analysis band. Above ~2.5 kHz the atmosphere has removed almost everything
# from a source more than a kilometre away, so including it only adds noise.
BAND_LO_HZ, BAND_HI_HZ = 40.0, 2500.0

# Width of the median filter used for whitening, in Hz. Wide enough to pass
# over a tone without following it, narrow enough to track the spectral slope.
WHITEN_HZ = 60.0

NFFT = 8192  # 1.95 Hz per bin at 16 kHz - fine enough to resolve a comb.


def _median_filter(x: np.ndarray, k: int) -> np.ndarray:
    """Running median. Written out because scipy is not a dependency."""
    if k < 3:
        return x.copy()
    k |= 1  # force odd
    pad = k // 2
    padded = np.pad(x, pad, mode="edge")
    # Strided view: (len(x), k) without copying the whole thing per position.
    shape = (len(x), k)
    strides = (padded.strides[0], padded.strides[0])
    windows = np.lib.stride_tricks.as_strided(padded, shape=shape, strides=strides)
    return np.median(windows, axis=1)


def welch_spectrum(pcm: np.ndarray, sr: int, nfft: int = NFFT) -> tuple[np.ndarray, np.ndarray]:
    """Averaged power spectrum. This is where the processing gain comes from."""
    if len(pcm) < nfft:
        pcm = np.pad(pcm, (0, nfft - len(pcm)))
    hop = nfft // 2
    win = np.hanning(nfft).astype(np.float32)
    # Normalising by the window's own power keeps levels comparable between
    # events of different length.
    scale = 1.0 / (np.sum(win ** 2) + 1e-12)
    frames = 1 + (len(pcm) - nfft) // hop
    acc = np.zeros(nfft // 2 + 1, dtype=np.float64)
    for i in range(frames):
        seg = pcm[i * hop : i * hop + nfft] * win
        acc += np.abs(np.fft.rfft(seg)) ** 2 * scale
    acc /= max(frames, 1)
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    return freqs, acc


def comb(pcm: np.ndarray, sr: int) -> dict:
    """Measure harmonic-comb structure over a whole event.

    Returns measurements, not a classification:

      comb_db       prominence of the best harmonic spacing, in dB above the
                    surrounding autocorrelation. 0 means no regular structure.
      f0_hz         the spacing itself - a candidate blade-pass or firing rate.
      n_harmonics   how many multiples of f0 carry a resolvable tone.
      tonal_db      how much of the band energy sits in narrow peaks rather
                    than broadband. Wind is near 0; an engine is not.
    """
    pcm = np.asarray(pcm, dtype=np.float32)
    if len(pcm) < sr:  # under a second, nothing to integrate
        return {"comb_db": 0.0, "f0_hz": 0.0, "n_harmonics": 0, "tonal_db": 0.0}

    freqs, power = welch_spectrum(pcm, sr)
    df = float(freqs[1] - freqs[0])
    band = (freqs >= BAND_LO_HZ) & (freqs <= BAND_HI_HZ)
    spec_db = 10.0 * np.log10(power[band] + 1e-20)

    # Whiten. What remains is how far each bin stands above its own
    # neighbourhood - broadband shape removed, tones preserved.
    baseline = _median_filter(spec_db, int(WHITEN_HZ / df))
    resid = spec_db - baseline
    tonal_db = float(np.mean(np.maximum(resid, 0.0)))

    # Only positive excursions carry tonal information; clipping the negatives
    # stops troughs between tones from correlating as though they were tones.
    r = np.maximum(resid, 0.0)
    r = r - r.mean()
    if not np.any(r):
        return {"comb_db": 0.0, "f0_hz": 0.0, "n_harmonics": 0, "tonal_db": round(tonal_db, 3)}

    # Autocorrelate along frequency. Lag is measured in bins, so lag * df is a
    # spacing in Hz.
    n = len(r)
    spec = np.fft.rfft(r, 2 * n)
    ac = np.fft.irfft(np.abs(spec) ** 2)[:n]
    ac /= ac[0] + 1e-20

    lo = max(1, int(F0_MIN_HZ / df))
    hi = min(n - 1, int(F0_MAX_HZ / df))
    if hi <= lo:
        return {"comb_db": 0.0, "f0_hz": 0.0, "n_harmonics": 0, "tonal_db": round(tonal_db, 3)}

    window = ac[lo:hi]
    k = int(np.argmax(window))
    peak = float(window[k])
    lag = lo + k
    f0 = lag * df

    # Prominence against the rest of the search range, so a slowly varying
    # autocorrelation does not read as a peak.
    others = np.concatenate([window[: max(0, k - 3)], window[k + 4 :]])
    floor = float(np.median(others)) if len(others) else 0.0
    spread = float(np.std(others)) if len(others) else 0.0
    comb_db = 10.0 * np.log10(max(peak, 1e-6) / max(floor + spread, 1e-6)) if peak > 0 else 0.0

    # Count harmonics that genuinely carry a tone: at least 3 dB above the
    # whitened baseline, near each multiple of the spacing.
    #
    # `resid` is indexed from BAND_LO_HZ, not from 0 Hz, so harmonic m sits at
    # (m*f0 - BAND_LO_HZ)/df and NOT at m*lag. Getting that wrong probed every
    # harmonic 40 Hz high and reported 0 harmonics for a synthetic two-stroke
    # with twelve of them.
    n_harm = 0
    for m in range(1, 16):
        centre = int(round((m * f0 - BAND_LO_HZ) / df))
        if centre >= n:
            break
        # Tolerance grows with harmonic number: a source whose rate wanders by
        # a fixed fraction smears its high harmonics proportionally more.
        tol = max(2, int(round(0.02 * m * lag)))
        seg = resid[max(0, centre - tol) : centre + tol + 1]
        if len(seg) and float(np.max(seg)) >= 3.0:
            n_harm += 1

    return {
        "comb_db": round(max(0.0, comb_db), 2),
        "f0_hz": round(f0, 1),
        "n_harmonics": int(n_harm),
        "tonal_db": round(tonal_db, 3),
    }

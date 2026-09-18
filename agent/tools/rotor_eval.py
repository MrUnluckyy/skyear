"""Measure whether the rotor feature actually separates drones from everything else.

This exists because of how the previous attempt went wrong. `cpp_db` was
calibrated on a synthesised piston engine, scored 0.228, and a threshold of 0.12
was set from that. Real propellers then scored 0.066-0.077 - indistinguishable
from wind at 0.052 - and the feature has never fired on a real aircraft. The
error was not in the maths. It was calibrating a detector on audio we generated
ourselves and shipping the number.

So this tool will compute everything you ask of it on synthetic audio, and will
refuse to print a deployable threshold from it. A threshold requires recordings
of the real thing, made through the real microphone.

USAGE

  # Sanity check the feature on synthesis. Reports separation, no threshold.
  python tools/rotor_eval.py --synthetic

  # The real thing. One subdirectory per label, WAV files inside.
  #   corpus/drone/*.wav      quadcopter or UAV, recorded through a camera mic
  #   corpus/scooter/*.wav    the hard negative: two-stroke, same f0 range
  #   corpus/traffic/*.wav    cars, trucks
  #   corpus/aircraft/*.wav   ADS-B confirmed, from the clip archive
  #   corpus/wind/*.wav       the most common false positive
  python tools/rotor_eval.py --corpus corpus/

  # Both: check that real recordings land where synthesis said they would.
  python tools/rotor_eval.py --corpus corpus/ --synthetic
"""
from __future__ import annotations

import argparse
import math
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skyear.rotor import comb  # noqa: E402

SR = 16000
POSITIVE = "drone"


# --- synthesis, for smoke-testing the maths only ------------------------

def _harmonic_stack(t, f0, n_harm, rolloff_db, jitter=0.0):
    """A periodic source: fundamental plus harmonics falling away.

    Phase is integrated from the instantaneous frequency, not multiplied by t.
    sin(2*pi*f(t)*t) is not frequency modulation - its instantaneous frequency
    is f(t) + t*f'(t), so the deviation grows without bound and a 0.6 Hz
    "jitter" became a 35 Hz chirp over a 30 s example. That smeared the
    synthetic scooter across 60 Hz and made the rotor feature look like it
    separated scooters from drones when all it was seeing was my own bug.
    """
    out = np.zeros_like(t)
    dt = t[1] - t[0] if len(t) > 1 else 1.0 / SR
    for m in range(1, n_harm + 1):
        amp = 10 ** (-rolloff_db * (m - 1) / 20.0)
        inst_f = f0 * m * (1.0 + jitter * np.sin(2 * np.pi * 0.3 * t + m))
        phase = 2 * np.pi * np.cumsum(inst_f) * dt
        out += amp * np.sin(phase)
    return out


def synth(kind: str, seconds=30.0, snr_db=6.0, seed=0) -> np.ndarray:
    """Generate a labelled example. NOT calibration data - see module docstring."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR

    if kind == "drone":
        # Quadcopter: four rotors at slightly different RPM, so their combs beat
        # against each other. Blade pass ~2 x rotor rate.
        sig = np.zeros_like(t)
        for i, rpm in enumerate((5800, 5950, 6100, 6020)):
            f0 = rpm / 60.0 * 2
            sig += _harmonic_stack(t, f0, 8, 4.0, jitter=0.002) * (0.9 + 0.1 * i)
        sig *= 1.0 + 0.15 * np.sin(2 * np.pi * 4.0 * t)  # rotor beating
    elif kind == "shahed":
        # Two-stroke piston driving a pusher propeller. Low fundamental, many
        # harmonics - the "moped" character.
        sig = _harmonic_stack(t, 92.0, 14, 2.6, jitter=0.004)
        sig += 0.5 * _harmonic_stack(t, 184.0, 6, 3.5)  # propeller blade pass
    elif kind == "scooter":
        # The hard negative. Deliberately close to the Shahed: same engine
        # class, same fundamental range. If the feature separates these two,
        # be suspicious of the synthesis, not pleased with the feature.
        sig = _harmonic_stack(t, 105.0, 12, 2.9, jitter=0.006)
        sig *= 1.0 + 0.3 * np.exp(-((t - seconds / 2) ** 2) / 8.0)  # passes by
    elif kind == "traffic":
        # Broadband tyre roar with a weak low engine order.
        noise = rng.normal(0, 1, len(t))
        b = np.fft.rfft(noise)
        f = np.fft.rfftfreq(len(t), 1 / SR)
        b *= 1.0 / (1.0 + (f / 300.0) ** 1.4)
        sig = np.fft.irfft(b, len(t))
        sig = sig / (np.std(sig) + 1e-9)
        sig += 0.25 * _harmonic_stack(t, 42.0, 4, 6.0)
    elif kind == "jet":
        # Broadband, no resolvable comb at distance.
        noise = rng.normal(0, 1, len(t))
        b = np.fft.rfft(noise)
        f = np.fft.rfftfreq(len(t), 1 / SR)
        b *= 1.0 / (1.0 + (f / 180.0) ** 1.1)
        sig = np.fft.irfft(b, len(t))
        sig = sig / (np.std(sig) + 1e-9)
    elif kind == "wind":
        noise = rng.normal(0, 1, len(t))
        b = np.fft.rfft(noise)
        f = np.fft.rfftfreq(len(t), 1 / SR)
        b *= 1.0 / (1.0 + (f / 70.0) ** 2.0)
        sig = np.fft.irfft(b, len(t))
        sig = sig / (np.std(sig) + 1e-9)
        sig *= 1.0 + 0.8 * np.sin(2 * np.pi * 0.15 * t)  # gusting
    else:
        raise ValueError(kind)

    sig = sig / (np.std(sig) + 1e-9)
    noise = rng.normal(0, 1, len(t))
    # Air absorption: anything far away has lost its top end. Applying this to
    # the signal but not the noise is what makes the test honest about range.
    b = np.fft.rfft(sig)
    f = np.fft.rfftfreq(len(t), 1 / SR)
    b *= np.exp(-((f / 1200.0) ** 1.5))
    sig = np.fft.irfft(b, len(t))
    sig = sig / (np.std(sig) + 1e-9)
    return (sig * 10 ** (snr_db / 20.0) + noise).astype(np.float32)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path.name}: need 16-bit PCM")
        raw = w.readframes(w.getnframes())
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
        if w.getframerate() != SR:
            # Linear resample. Crude, but the feature works on spacing, and a
            # resample preserves spacing.
            n = int(len(data) * SR / w.getframerate())
            data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data)
        return data


# --- scoring ------------------------------------------------------------

def auc(pos: list[float], neg: list[float]) -> float:
    """Probability a random positive scores above a random negative.

    0.5 is a coin flip. Computed directly rather than by ranking so that ties
    count as half, which matters when a feature saturates.
    """
    if not pos or not neg:
        return float("nan")
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def describe(values: list[float]) -> str:
    if not values:
        return "no samples"
    a = np.array(values)
    return f"n={len(a):3d}  median {np.median(a):6.2f}  p10 {np.percentile(a, 10):6.2f}  p90 {np.percentile(a, 90):6.2f}"


def evaluate(samples: dict[str, list[dict]], feature: str, synthetic_only: bool) -> None:
    print(f"\n=== {feature} ===")
    by_label = {k: [s[feature] for s in v] for k, v in samples.items()}
    for label in sorted(by_label):
        print(f"  {label:10s} {describe(by_label[label])}")

    if POSITIVE not in by_label:
        print(f"\n  No '{POSITIVE}' samples: nothing to separate.")
        return

    pos = by_label[POSITIVE]
    print()
    worst = (1.0, None)
    for label, vals in sorted(by_label.items()):
        if label == POSITIVE:
            continue
        a = auc(pos, vals)
        verdict = "useless" if a < 0.65 else "weak" if a < 0.8 else "usable" if a < 0.95 else "strong"
        print(f"  {POSITIVE} vs {label:10s} AUC {a:.3f}  {verdict}")
        if a < worst[0]:
            worst = (a, label)

    print()
    if synthetic_only:
        print("  NO THRESHOLD. These are synthesised signals. A threshold set from")
        print("  audio we generated ourselves is exactly how cpp_db ended up with a")
        print("  cutoff of 0.12 that no real aircraft has ever reached. Record a real")
        print("  drone through a real camera microphone, at a real distance, first.")
        return

    if worst[1] is None:
        return
    if worst[0] < 0.8:
        print(f"  NO THRESHOLD. Weakest separation is against '{worst[1]}' at AUC")
        print(f"  {worst[0]:.3f}. Below 0.8 there is no cutoff that is not mostly wrong.")
        return

    # Threshold at the point that maximises balanced accuracy against the
    # hardest negative class - not against the easy ones.
    hardest = by_label[worst[1]]
    grid = np.linspace(min(pos + hardest), max(pos + hardest), 400)
    best = max(
        grid,
        key=lambda t: (np.mean(np.array(pos) >= t) + np.mean(np.array(hardest) < t)) / 2,
    )
    tpr = float(np.mean(np.array(pos) >= best))
    fpr = float(np.mean(np.array(hardest) >= best))
    print(f"  Suggested threshold {best:.2f} (hardest negative: {worst[1]})")
    print(f"    catches {tpr * 100:.0f}% of drones, fires on {fpr * 100:.0f}% of {worst[1]}")
    if fpr > 0.1:
        print(f"    At a {fpr * 100:.0f}% false alarm rate this is not ready to turn a dot red.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, help="directory of labelled subdirectories of WAVs")
    ap.add_argument("--synthetic", action="store_true", help="include generated signals")
    ap.add_argument("--snr", type=float, default=6.0, help="synthetic SNR in dB (default 6)")
    ap.add_argument("--repeats", type=int, default=12, help="synthetic examples per class")
    args = ap.parse_args()

    if not args.corpus and not args.synthetic:
        ap.error("give --corpus, --synthetic, or both")

    samples: dict[str, list[dict]] = {}
    real_labels: set[str] = set()

    if args.corpus:
        for sub in sorted(p for p in args.corpus.iterdir() if p.is_dir()):
            files = sorted(sub.glob("*.wav"))
            if not files:
                continue
            rows = []
            for f in files:
                try:
                    rows.append(comb(read_wav(f), SR))
                except Exception as e:  # a bad file should not lose the run
                    print(f"  skipped {f}: {e}", file=sys.stderr)
            if rows:
                samples.setdefault(sub.name, []).extend(rows)
                real_labels.add(sub.name)
        print(f"corpus: {sum(len(v) for v in samples.values())} recordings "
              f"across {len(samples)} labels")

    if args.synthetic:
        # 'shahed' is folded into the positive class: it is the thing we are
        # actually looking for, and keeping it separate would let a feature that
        # only finds quadcopters look successful.
        for kind in ("drone", "shahed", "scooter", "traffic", "jet", "wind"):
            label = POSITIVE if kind in ("drone", "shahed") else kind
            for i in range(args.repeats):
                sig = synth(kind, snr_db=args.snr, seed=i * 17 + hash(kind) % 1000)
                samples.setdefault(label, []).append(comb(sig, SR))
        print(f"synthetic: {args.repeats} examples per class at {args.snr:.0f} dB SNR")

    synthetic_only = args.synthetic and POSITIVE not in real_labels
    for feature in ("comb_db", "n_harmonics", "tonal_db"):
        evaluate(samples, feature, synthetic_only)

    print()
    if synthetic_only:
        print("STATUS: uncalibrated. No real drone recordings in the corpus.")
        print("The map must not show a red dot until this says otherwise.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

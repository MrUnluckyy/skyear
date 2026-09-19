"""Train a sound classifier from your own labels, and report honestly.

USAGE

    python tools/train.py --data ./out                  # what you have so far
    python tools/train.py --data ./out --report         # per-class detail
    python tools/train.py --data ./out --export model.json

WHAT IT TRAINS ON

The features the detector already computes for every event: octave levels,
spectral tilt, periodicity, and the narrowband rotor comb. No audio is read.
This is deliberate - the point is a model small enough to run inside the agent
with numpy alone, scoring events as they finish, on a NAS.

WHY MULTINOMIAL LOGISTIC REGRESSION

Because it is honest at this sample size. With a few hundred labels, a deep
model memorises rather than learns and the accuracy it reports is fiction. A
linear model on well-chosen features cannot pretend that hard, its weights can
be read and argued with, and it is a few kilobytes.

It is also a floor, not a ceiling. When there are thousands of labels, the
route is embeddings from a pretrained audio model (YAMNet, EfficientAT) plus
this same classifier on top - see docs/drone-detection.md. Nothing here has to
change for that; only the feature vector gets longer.

HOW IT REPORTS

Cross-validated, never on the training set. A model scored on data it was
fitted to will report something impressive and mean nothing, and this project
has already been bitten once by a number calibrated on the wrong distribution.
Classes with too few examples are named and excluded rather than quietly
folded in.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skyear.labelling import LABELS, UNUSABLE  # noqa: E402

OCTAVES = ["50-100", "100-200", "200-400", "400-800", "800-1600", "1600-3200"]

# A class needs enough examples to be learnable and enough to be *tested*.
# Below this the cross-validated score is noise dressed as a number.
MIN_PER_CLASS = 12


def features(ev: dict) -> list[float] | None:
    """One event as a vector. Order is part of the model format."""
    oct_db = ev.get("octave_db")
    if not oct_db:
        return None
    v = [float(oct_db.get(b, -90.0)) for b in OCTAVES]
    # Shape rather than absolute level: a loud aircraft and a quiet one are
    # the same thing, and level mostly encodes distance.
    peak = max(v)
    shape = [x - peak for x in v]
    # Differences between adjacent bands - the slope, which is what actually
    # separated wind from everything else in the measured data.
    slopes = [v[i + 1] - v[i] for i in range(len(v) - 1)]

    def num(key, default=0.0):
        x = ev.get(key)
        return float(x) if isinstance(x, (int, float)) else default

    return shape + slopes + [
        num("low_tilt_db"),
        num("cpp_db"),
        num("tonal_db"),
        num("comb_db"),
        min(num("n_harmonics"), 15.0),
        np.log1p(max(num("comb_f0_hz"), 0.0)),
        np.log1p(max(num("dominant_hz"), 0.0)),
        np.log1p(max(num("duration_s"), 0.0)),
        num("snr_db") / 10.0,
    ]


FEATURE_NAMES = (
    [f"shape[{b}]" for b in OCTAVES]
    + [f"slope[{OCTAVES[i]}→{OCTAVES[i+1]}]" for i in range(len(OCTAVES) - 1)]
    + ["low_tilt_db", "cpp_db", "tonal_db", "comb_db", "n_harmonics",
       "log comb_f0", "log dominant_hz", "log duration", "snr/10"]
)


def load(data_dir: Path) -> tuple[np.ndarray, list[str], list[str]]:
    labels: dict[str, str] = {}
    lp = data_dir / "labels.jsonl"
    if lp.is_file():
        for line in lp.read_text(errors="ignore").splitlines():
            if line.strip():
                try:
                    row = json.loads(line)
                    labels[row["event_id"]] = row["label"]
                except (json.JSONDecodeError, KeyError):
                    pass

    X, y, ids = [], [], []
    ep = data_dir / "events.jsonl"
    if ep.is_file():
        for line in ep.read_text(errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            label = labels.get(ev.get("id", ""))
            if not label or label in UNUSABLE:
                continue
            f = features(ev)
            if f is None:
                continue
            X.append(f)
            y.append(label)
            ids.append(ev["id"])
    return np.array(X, dtype=np.float64), y, ids


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def fit(X: np.ndarray, Y: np.ndarray, epochs=600, lr=0.25, l2=1e-3):
    """Plain gradient descent. numpy only, by design - this has to run where
    the agent runs, and the agent's whole dependency list is numpy and PyYAML."""
    n, d = X.shape
    k = Y.shape[1]
    W = np.zeros((d, k))
    b = np.zeros(k)
    for _ in range(epochs):
        P = softmax(X @ W + b)
        G = (P - Y) / n
        W -= lr * (X.T @ G + l2 * W)
        b -= lr * G.sum(axis=0)
    return W, b


def standardise(X: np.ndarray):
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd < 1e-9] = 1.0
    return mu, sd


def cross_validate(X, y, classes, folds=5, seed=0):
    """Stratified k-fold. Returns predictions for every row, each made by a
    model that never saw it."""
    rng = np.random.default_rng(seed)
    idx_by_class = {c: rng.permutation([i for i, v in enumerate(y) if v == c]) for c in classes}
    fold_of = np.zeros(len(y), dtype=int)
    for c, idxs in idx_by_class.items():
        for j, i in enumerate(idxs):
            fold_of[i] = j % folds

    pred = [""] * len(y)
    for f in range(folds):
        tr = np.where(fold_of != f)[0]
        te = np.where(fold_of == f)[0]
        if len(te) == 0 or len(tr) == 0:
            continue
        mu, sd = standardise(X[tr])
        Xtr = (X[tr] - mu) / sd
        Y = np.zeros((len(tr), len(classes)))
        for row, i in enumerate(tr):
            Y[row, classes.index(y[i])] = 1
        W, b = fit(Xtr, Y)
        P = softmax(((X[te] - mu) / sd) @ W + b)
        for row, i in enumerate(te):
            pred[i] = classes[int(np.argmax(P[row]))]
    return pred


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path("out"))
    ap.add_argument("--report", action="store_true", help="per-class detail and confusions")
    ap.add_argument("--export", type=Path, help="write the fitted model as JSON")
    args = ap.parse_args()

    X, y, _ = load(args.data)
    if len(y) == 0:
        print("No labelled events yet.")
        print(f"Open the agent's /label page and work through the queue, then run this again.")
        return 0

    counts = Counter(y)
    print(f"{len(y)} labelled events with usable features\n")
    for c, n in counts.most_common():
        mark = "" if n >= MIN_PER_CLASS else f"  (needs {MIN_PER_CLASS - n} more to be usable)"
        print(f"  {LABELS.get(c, c):36s} {n:4d}{mark}")

    classes = sorted(c for c, n in counts.items() if n >= MIN_PER_CLASS)
    if len(classes) < 2:
        print(f"\nNot enough yet. Two classes need {MIN_PER_CLASS}+ examples each before a")
        print("model can be trained, let alone trusted. Keep labelling.")
        return 0

    keep = [i for i, v in enumerate(y) if v in classes]
    X, y = X[keep], [y[i] for i in keep]
    dropped = set(counts) - set(classes)
    if dropped:
        print(f"\nExcluded, too few examples: {', '.join(sorted(dropped))}")

    pred = cross_validate(X, y, classes)
    correct = sum(p == t for p, t in zip(pred, y))
    # The honest yardstick: always guessing the commonest class.
    base = max(Counter(y).values()) / len(y)
    print(f"\nCross-validated accuracy  {correct / len(y):.1%}")
    print(f"Always guessing '{Counter(y).most_common(1)[0][0]}'  {base:.1%}")
    if correct / len(y) <= base + 0.02:
        print("\nThe model is not beating the majority class. More labels, or the features")
        print("do not carry the distinction you are asking for.")

    if args.report:
        print("\nPer class:")
        print(f"  {'':22s} {'recall':>8s} {'precision':>10s}")
        for c in classes:
            tp = sum(1 for p, t in zip(pred, y) if p == c and t == c)
            actual = sum(1 for t in y if t == c)
            said = sum(1 for p in pred if p == c)
            print(f"  {LABELS.get(c, c):22s} {tp / max(actual,1):8.0%} {tp / max(said,1):10.0%}")

        print("\nConfused for each other (actual → predicted, 2+ times):")
        conf = Counter((t, p) for t, p in zip(y, pred) if t != p)
        for (t, p), n in conf.most_common():
            if n >= 2:
                print(f"  {t:12s} → {p:12s} {n:3d}")

    if args.export:
        mu, sd = standardise(X)
        Y = np.zeros((len(y), len(classes)))
        for i, v in enumerate(y):
            Y[i, classes.index(v)] = 1
        W, b = fit((X - mu) / sd, Y)
        args.export.write_text(json.dumps({
            "classes": classes,
            "features": FEATURE_NAMES,
            "mean": mu.tolist(),
            "scale": sd.tolist(),
            "weights": W.tolist(),
            "bias": b.tolist(),
            "trained_on": len(y),
            "cv_accuracy": correct / len(y),
        }, indent=1))
        print(f"\nWrote {args.export} — {len(y)} examples, {len(classes)} classes.")
        print("It reports its own cross-validated accuracy; anything using it should read that")
        print("and refuse to act on a model that has not earned it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

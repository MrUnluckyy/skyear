"""Adaptive band-energy event detector.

Flags sustained sound events that rise above the rolling noise floor in the
engine band. This is intentionally simple: it is the data collector that the
ML classifier will later be trained on.
"""
import collections
import math

import numpy as np

OCTAVES = [(50, 100), (100, 200), (200, 400), (400, 800), (800, 1600), (1600, 3200)]


class BandEnergyDetector:
    def __init__(self, sr=16000, frame_s=0.5, band_hz=(50, 2000), threshold_db=8.0,
                 release_db=4.0, min_duration_s=4.0, release_s=3.0, max_event_s=240.0,
                 floor_window_s=180.0, floor_percentile=20.0, warmup_s=30.0):
        self.sr = sr
        self.n = int(sr * frame_s)
        self.frame_s = self.n / sr
        self.win = np.hanning(self.n).astype(np.float32)
        freqs = np.fft.rfftfreq(self.n, 1 / sr)
        self.freqs = freqs
        self.band = (freqs >= band_hz[0]) & (freqs <= band_hz[1])
        self.oct_masks = [(freqs >= lo) & (freqs < hi) for lo, hi in OCTAVES]
        self.thr, self.rel = threshold_db, release_db
        self.min_frames = max(1, int(min_duration_s / self.frame_s))
        self.release_frames = max(1, int(release_s / self.frame_s))
        self.max_frames = int(max_event_s / self.frame_s)
        self.hist = collections.deque(maxlen=int(floor_window_s / self.frame_s))
        self.pct = floor_percentile
        self.warmup_frames = int(warmup_s / self.frame_s)
        self.seen = 0
        self.pending = np.zeros(0, dtype=np.float32)
        self.pending_t = None
        self.cand = []      # frames above threshold, not yet an event
        self.active = None  # list of frames in event
        self.below = 0
        self.floor = None

    def _frame(self, x):
        spec = np.abs(np.fft.rfft(x * self.win)) ** 2 + 1e-20
        db = 10 * math.log10(spec[self.band].mean())
        bi = np.flatnonzero(self.band)
        peak_f = float(self.freqs[bi[np.argmax(spec[bi])]])
        octs = [10 * math.log10(spec[m].mean()) for m in self.oct_masks]
        return db, peak_f, octs

    def process(self, t, x):
        """Feed audio; returns list of finished events (dicts)."""
        if self.pending_t is None or len(self.pending) == 0:
            self.pending_t = t
        self.pending = np.concatenate([self.pending, x])
        out = []
        while len(self.pending) >= self.n:
            fx, self.pending = self.pending[: self.n], self.pending[self.n:]
            ft = self.pending_t
            self.pending_t += self.frame_s
            ev = self._step(ft, fx)
            if ev:
                out.append(ev)
        return out

    def _step(self, t, x):
        db, peak_f, octs = self._frame(x)
        self.seen += 1
        floor = float(np.percentile(self.hist, self.pct)) if len(self.hist) > 10 else db
        self.floor = floor
        fr = (t, db, peak_f, octs)

        if self.active is None:
            if self.seen > self.warmup_frames and db > floor + self.thr:
                self.cand.append(fr)
                if len(self.cand) >= self.min_frames:
                    self.active, self.cand, self.below = self.cand, [], 0
                    self.event_floor = floor
            else:
                for c in self.cand:
                    self.hist.append(c[1])
                self.cand = []
                self.hist.append(db)
            return None

        self.active.append(fr)
        self.below = self.below + 1 if db < self.event_floor + self.rel else 0
        if self.below >= self.release_frames or len(self.active) >= self.max_frames:
            frames = self.active[: -self.below] if 0 < self.below < len(self.active) else self.active
            self.active = None
            return self._summarise(frames)
        return None

    def _summarise(self, frames):
        ts = np.array([f[0] for f in frames])
        dbs = np.array([f[1] for f in frames])
        pk = int(np.argmax(dbs))
        octs = np.array([f[3] for f in frames]).mean(axis=0)
        return {
            "start": float(ts[0]),
            "end": float(ts[-1] + self.frame_s),
            "duration_s": round(float(ts[-1] + self.frame_s - ts[0]), 1),
            "peak_time": float(ts[pk]),
            "peak_db": round(float(dbs[pk]), 1),
            "floor_db": round(float(self.event_floor), 1),
            "snr_db": round(float(dbs[pk] - self.event_floor), 1),
            "dominant_hz": round(float(np.median([f[2] for f in frames])), 1),
            "octave_db": {f"{lo}-{hi}": round(float(v), 1) for (lo, hi), v in zip(OCTAVES, octs)},
        }

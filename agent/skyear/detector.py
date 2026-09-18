"""Adaptive band-energy event detector.

Flags sustained sound events that rise above the rolling noise floor in the
engine band. This is intentionally simple: it is the data collector that the
ML classifier will later be trained on.
"""
import collections
import math

import numpy as np

from .rotor import comb

OCTAVES = [(50, 100), (100, 200), (200, 400), (400, 800), (800, 1600), (1600, 3200)]

# Periodicity, measured by cepstral peak prominence.
#
# Calibrated against real recordings and synthetic sources:
#
#   piston engine, 12 harmonics   0.228   <- the Shahed signature
#   piston at  0 dB SNR in wind   0.148   <- still clear when as loud as the gale
#   piston at -6 dB SNR in wind   0.126   <- still clear when quieter than it
#   our own field recordings      0.060-0.101
#   wind                          0.053
#   white noise                   0.051
#   synthetic turbofan (3 tones)  0.063
#
# The last line is the important caveat: this separates DENSE harmonic stacks
# from noise, so it is strong for piston drones and weak for jets, whose energy
# is mostly broadband roar. It found no separation at all between our
# aircraft-matched and unmatched events - consistent with those recordings
# containing no engine at any useful level.
#
# The default sits above every observed noise value and below a piston buried
# 6 dB under wind.
F0_MIN_HZ, F0_MAX_HZ = 55.0, 400.0


class BandEnergyDetector:
    def __init__(self, sr=16000, frame_s=0.5, band_hz=(50, 2000), threshold_db=8.0,
                 release_db=4.0, min_duration_s=4.0, release_s=3.0, max_event_s=240.0,
                 floor_window_s=180.0, floor_percentile=20.0, warmup_s=30.0,
                 wind_tilt_db=20.0, harmonic_cpp_db=0.12, comb_max_s=60.0):
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
        self.wind_tilt_db = wind_tilt_db
        self.harmonic_cpp_db = harmonic_cpp_db
        # The rotor comb integrates over the whole event rather than per frame,
        # so it needs the audio itself. Capped because a 240 s event at 16 kHz
        # is 15 MB and this runs on a Raspberry Pi; 60 s already buys ~230
        # Welch averages, and the gain past that is under a dB.
        self.comb_max_samples = int(comb_max_s * sr)
        self.ev_pcm: list = []
        self.ev_samples = 0
        # Audio for frames that have crossed the threshold but not yet lasted
        # long enough to be an event. Carried into the event when one opens -
        # without it the first min_duration_s of every sound is missing from the
        # rotor analysis, which for a short event is most of it.
        self.cand_pcm: list = []
        # Quefrency bounds for a plausible engine fundamental.
        self.q_lo = max(2, int(sr / F0_MAX_HZ))
        self.q_hi = min(self.n // 2, int(sr / F0_MIN_HZ))
        self.seen = 0
        self.pending = np.zeros(0, dtype=np.float32)
        self.pending_t = None
        self.cand = []      # frames above threshold, not yet an event
        self.active = None  # list of frames in event
        self.below = 0
        self.floor = None
        self.last_db = None
        self.last_cpp = None

    def _cpp(self, spec):
        """Cepstral peak prominence, and the fundamental it implies.

        The cepstrum is the spectrum of the log-spectrum, so a regularly spaced
        harmonic stack collapses into a single peak at the quefrency of its
        fundamental period. Noise produces no such peak. The value returned is
        the peak height above a straight-line fit through the surrounding
        cepstrum, which makes it independent of loudness - a quiet engine still
        reads as periodic, and a roaring gale still does not.
        """
        cep = np.fft.irfft(np.log(spec))
        lo, hi = self.q_lo, self.q_hi
        window = cep[lo:hi]
        if window.size < 4:
            return 0.0, 0.0
        idx = np.arange(window.size)
        # The cepstrum slopes, so the peak matters relative to that slope.
        slope, intercept = np.polyfit(idx, window, 1)
        resid = window - (slope * idx + intercept)
        k = int(np.argmax(resid))
        return float(resid[k]), float(self.sr / (lo + k))

    def _frame(self, x):
        spec = np.abs(np.fft.rfft(x * self.win)) ** 2 + 1e-20
        db = 10 * math.log10(spec[self.band].mean())
        bi = np.flatnonzero(self.band)
        peak_f = float(self.freqs[bi[np.argmax(spec[bi])]])
        octs = [10 * math.log10(spec[m].mean()) for m in self.oct_masks]
        cpp, f0 = self._cpp(spec)
        return db, peak_f, octs, cpp, f0

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

    def state(self) -> dict:
        """What this detector is hearing right now.

        The event stream only reports a sound once it has *ended*, so a live
        view needs this: the current level against the rolling floor, and
        whether a candidate or event is open at this instant.
        """
        level = self.last_db
        floor = self.floor
        return {
            "level_db": None if level is None else round(float(level), 1),
            "floor_db": None if floor is None else round(float(floor), 1),
            "excess_db": None if level is None or floor is None else round(float(level - floor), 1),
            # A candidate has crossed the threshold but not yet lasted long
            # enough to count - worth showing, because that is the moment a
            # listener would say "something is starting".
            "rising": bool(self.cand) and self.active is None,
            "event_active": self.active is not None,
            "event_s": round(len(self.active) * self.frame_s, 1) if self.active else 0.0,
            "harmonic": bool(self.last_cpp is not None and self.last_cpp >= self.harmonic_cpp_db),
            "warm": self.seen > self.warmup_frames,
        }

    def _step(self, t, x):
        db, peak_f, octs, cpp, f0 = self._frame(x)
        self.last_db = db
        self.last_cpp = cpp
        self.seen += 1
        floor = float(np.percentile(self.hist, self.pct)) if len(self.hist) > 10 else db
        self.floor = floor
        fr = (t, db, peak_f, octs, cpp, f0)

        if self.active is None:
            if self.seen > self.warmup_frames and db > floor + self.thr:
                self.cand.append(fr)
                self.cand_pcm.append(x)
                if len(self.cand) >= self.min_frames:
                    self.active, self.cand, self.below = self.cand, [], 0
                    self.event_floor = floor
                    self.ev_pcm = self.cand_pcm
                    self.ev_samples = sum(len(c) for c in self.ev_pcm)
                    self.cand_pcm = []
            else:
                for c in self.cand:
                    self.hist.append(c[1])
                self.cand = []
                self.cand_pcm = []
                self.hist.append(db)
            return None

        self.active.append(fr)
        if self.ev_samples < self.comb_max_samples:
            self.ev_pcm.append(x)
            self.ev_samples += len(x)
        self.below = self.below + 1 if db < self.event_floor + self.rel else 0
        if self.below >= self.release_frames or len(self.active) >= self.max_frames:
            # Hitting the cap means the sound did not stop, we did. That has to
            # travel with the event: a continuous noise source otherwise arrives
            # as a run of separate "unexplained sounds", each counted once, and
            # inflates both the event count and the duty cycle.
            truncated = len(self.active) >= self.max_frames
            frames = self.active[: -self.below] if 0 < self.below < len(self.active) else self.active
            pcm = np.concatenate(self.ev_pcm) if self.ev_pcm else np.zeros(0, dtype=np.float32)
            self.active = None
            self.ev_pcm = []
            self.ev_samples = 0
            return self._summarise(frames, pcm, truncated=truncated)
        return None

    def _summarise(self, frames, pcm=None, truncated=False):
        ts = np.array([f[0] for f in frames])
        dbs = np.array([f[1] for f in frames])
        pk = int(np.argmax(dbs))
        octs = np.array([f[3] for f in frames]).mean(axis=0)
        by_band = {f"{lo}-{hi}": round(float(v), 1) for (lo, hi), v in zip(OCTAVES, octs)}
        # Wind is concentrated below ~100 Hz and falls away steeply; an aircraft
        # puts real energy into 100-400 Hz. The gap between those bands
        # separates the two cheaply, using features already computed.
        tilt = by_band["50-100"] - by_band["200-400"]

        # Periodicity over the event. The median resists a single frame where a
        # car or a door happened to land inside an otherwise noisy stretch.
        cpps = np.array([f[4] for f in frames])
        cpp = float(np.median(cpps))
        harmonic = bool(cpp >= self.harmonic_cpp_db)
        # F0 is only meaningful where the frame was actually periodic.
        strong = cpps >= self.harmonic_cpp_db
        f0 = float(np.median([f[5] for f, ok in zip(frames, strong) if ok])) if strong.any() else 0.0

        rotor = (comb(pcm, self.sr) if pcm is not None and len(pcm)
                 else {"comb_db": 0.0, "f0_hz": 0.0, "n_harmonics": 0, "tonal_db": 0.0})
        # rotor.f0_hz is a spacing measured across the whole event and is the
        # better estimate; keep the cepstral one under its own name rather than
        # letting two different quantities share a key.
        rotor = {"comb_db": rotor["comb_db"], "comb_f0_hz": rotor["f0_hz"],
                 "n_harmonics": rotor["n_harmonics"], "tonal_db": rotor["tonal_db"]}

        return {
            "start": float(ts[0]),
            "end": float(ts[-1] + self.frame_s),
            "duration_s": round(float(ts[-1] + self.frame_s - ts[0]), 1),
            "peak_time": float(ts[pk]),
            "peak_db": round(float(dbs[pk]), 1),
            "floor_db": round(float(self.event_floor), 1),
            "snr_db": round(float(dbs[pk] - self.event_floor), 1),
            "dominant_hz": round(float(np.median([f[2] for f in frames])), 1),
            "octave_db": by_band,
            "low_tilt_db": round(float(tilt), 1),
            "cpp_db": round(cpp, 3),
            "harmonic": harmonic,
            "f0_hz": round(f0, 1),
            # Wind is low-tilt AND aperiodic. Requiring both stops the tilt test
            # from discarding a distant aircraft, whose spectrum is genuinely
            # low-tilt because the atmosphere absorbs its high frequencies -
            # which is exactly how a real B738 pass got thrown away as wind.
            "likely_wind": bool(tilt >= self.wind_tilt_db and not harmonic),
            # A slice of something longer, not a whole sound.
            "truncated": bool(truncated),
            # Narrowband rotor structure, integrated over the whole event. This
            # is the feature that can see a propeller; the octave bands cannot,
            # and cpp_db does not survive the trip through real air. See
            # rotor.py for why, and for what it still cannot tell apart.
            **rotor,
        }

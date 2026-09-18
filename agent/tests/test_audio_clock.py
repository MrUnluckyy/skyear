"""The audio timeline must not drift away from the clock.

A long-running agent produced events stamped over three hours in the past while
writing them in real time. That is not merely a display problem: ADS-B matching
looks up aircraft positions by event timestamp, and a stale one falls outside
the track history, so every detection comes back unexplained. The sensor
appeared to stop hearing aircraft when it had actually stopped knowing when it
was.
"""
import time
from itertools import islice

import numpy as np

from skyear.audio import AudioSource


class FakeProc:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.stdout = self
        self.stderr = self

    def read(self, n=-1):
        return self._chunks.pop(0) if self._chunks else b""

    def kill(self):
        pass

    def wait(self):
        pass


def silence(seconds, sr=16000):
    return np.zeros(int(sr * seconds), dtype="<i2").tobytes()


def take(src, count):
    """A live source reconnects forever, so never iterate it to exhaustion."""
    out = list(islice(src.chunks(), count))
    src.stop()
    return out


def test_timestamps_track_the_clock(monkeypatch):
    src = AudioSource("rtsp://x", sr=16000, chunk_s=0.25, live=True)
    monkeypatch.setattr("skyear.audio.subprocess.Popen",
                        lambda *a, **k: FakeProc([silence(0.25)] * 40))
    for t, _ in take(src, 8):
        assert abs(t - time.time()) < 3.0, "timestamps must stay near wall time"


def test_a_stalled_stream_cannot_leave_timestamps_in_the_past(monkeypatch):
    """The failure that happened: the sample-counted timeline falls behind the
    clock and, without re-anchoring, never catches up."""
    src = AudioSource("rtsp://x", sr=16000, chunk_s=0.25, live=True)

    real_time = time.time
    offset = {"v": 0.0}
    monkeypatch.setattr("skyear.audio.time.time", lambda: real_time() + offset["v"])
    monkeypatch.setattr("skyear.audio.subprocess.Popen",
                        lambda *a, **k: FakeProc([silence(0.25)] * 40))

    stamps = []
    for i, (t, _) in enumerate(src.chunks()):
        stamps.append(t)
        if i == 1:
            offset["v"] = 3 * 3600  # three hours pass between two chunks
        if i >= 5:
            break
    src.stop()

    for t in stamps[3:]:
        assert abs(t - (real_time() + offset["v"])) < 3.0, (
            "a stalled stream must not leave timestamps hours behind"
        )


def test_replay_keeps_file_relative_time(monkeypatch):
    """Replay is not live, so its timeline belongs to the file, not the clock."""
    src = AudioSource("/tmp/x.wav", sr=16000, chunk_s=0.25, live=False)
    monkeypatch.setattr("skyear.audio.subprocess.Popen",
                        lambda *a, **k: FakeProc([silence(0.25)] * 4))
    stamps = [t for t, _ in src.chunks(file_t0=0.0)]
    assert stamps[0] == 0.0
    assert stamps[-1] < 1.0, "file time advances by content, not by clock"

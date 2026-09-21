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


# --- the detector's own timeline ----------------------------------------

def test_event_times_follow_the_audio_clock_after_a_stall():
    """A stall must not leave the detector stamping events in the past.

    audio.py re-anchors its timestamps to wall time when a stream stalls. The
    detector used to ignore that and keep counting frames, so a laptop that
    slept for a day carried on stamping events a day behind - they uploaded,
    they stored, and every aircraft match failed against a sky that was no
    longer there. This is that bug.
    """
    import numpy as np
    from skyear.detector import BandEnergyDetector

    det = BandEnergyDetector(sr=16000)
    # One short read - an odd byte count trimmed to an odd sample count - is
    # all it takes: from then on the buffer never empties exactly, which is
    # what the old re-sync condition waited for.
    chunk = np.zeros(3999, dtype=np.float32)

    t = 1_000_000.0
    for _ in range(20):
        det.process(t, chunk)
        t += 0.25

    # The stream stalls for a day; audio.py re-anchors and the next chunk
    # arrives with a timestamp far ahead of where the frame timeline sits.
    t += 86_400.0
    det.process(t, chunk)

    behind = t - det.pending_t
    assert behind < 2.0, f"detector is {behind:.0f} s behind the audio clock after a stall"


def test_the_frame_timeline_is_not_jittered_by_ordinary_chunks():
    """Re-syncing must not fire on normal operation, or frame times wander."""
    import numpy as np
    from skyear.detector import BandEnergyDetector

    det = BandEnergyDetector(sr=16000)
    chunk = np.zeros(3999, dtype=np.float32)
    t = 500_000.0
    for _ in range(40):
        det.process(t, chunk)
        t += 0.25

    # pending_t is the start of what is still buffered, so it sits just behind
    # the last chunk timestamp - never ahead, never drifting away.
    gap = t - det.pending_t
    assert 0 <= gap <= 0.5, f"frame timeline drifted {gap:.3f} s from the audio clock"

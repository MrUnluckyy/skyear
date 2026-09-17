"""Outbox cursor semantics.

The JSONL files are the outbox and the byte offset is the only record of what
has shipped. If the offset advances on a failed upload the data is gone, and if
a partial line is consumed the record is corrupted - so both are tested here.
"""
import json
import threading

import pytest

from skyear import uploader as up
from skyear.uploader import Outbox, Uploader, coarse


def write_lines(path, records, trailing_partial=None):
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
        if trailing_partial:
            f.write(trailing_partial)  # deliberately no newline
    return path


def test_coarse_hides_precise_position():
    """The cloud must never be told an exact sensor location."""
    assert coarse(54.687213456) == 54.687
    assert coarse(25.279798765) == 25.280
    # ~110 m of ambiguity at this latitude
    assert abs(coarse(54.6872) - 54.6872) < 0.001


def test_outbox_reads_all_complete_lines(tmp_path):
    p = write_lines(tmp_path / "events.jsonl", [{"id": "a"}, {"id": "b"}])
    box = Outbox(p)
    records, offset = box.read_batch()
    assert [r["id"] for r in records] == ["a", "b"]
    assert offset == p.stat().st_size


def test_outbox_leaves_a_partial_trailing_line(tmp_path):
    """The agent may be mid-write; half a JSON object must not be consumed."""
    p = write_lines(tmp_path / "events.jsonl", [{"id": "a"}], trailing_partial='{"id": "b"')
    box = Outbox(p)
    records, offset = box.read_batch()
    assert [r["id"] for r in records] == ["a"]
    assert offset < p.stat().st_size

    # once the line is completed, it is picked up
    with open(p, "a") as f:
        f.write(', "x": 1}\n')
    box.offset = offset
    records, _ = box.read_batch()
    assert [r["id"] for r in records] == ["b"]


def test_outbox_resumes_from_its_offset(tmp_path):
    p = write_lines(tmp_path / "events.jsonl", [{"id": "a"}, {"id": "b"}])
    box = Outbox(p)
    _, offset = box.read_batch()
    box.offset = offset
    assert box.read_batch() == ([], offset)

    with open(p, "a") as f:
        f.write(json.dumps({"id": "c"}) + "\n")
    records, _ = box.read_batch()
    assert [r["id"] for r in records] == ["c"]


def test_outbox_handles_truncation(tmp_path):
    p = write_lines(tmp_path / "events.jsonl", [{"id": "a"}, {"id": "b"}])
    box = Outbox(p, offset=10_000)          # offset past a now-smaller file
    records, _ = box.read_batch()
    assert [r["id"] for r in records] == ["a", "b"]


def test_outbox_skips_malformed_lines_without_stalling(tmp_path):
    p = tmp_path / "events.jsonl"
    p.write_text('{"id": "a"}\nnot json\n{"id": "b"}\n')
    records, offset = Outbox(p).read_batch()
    assert [r["id"] for r in records] == ["a", "b"]
    assert offset == p.stat().st_size


def test_outbox_missing_file_is_not_an_error(tmp_path):
    assert Outbox(tmp_path / "nope.jsonl").read_batch() == ([], 0)


def test_outbox_respects_the_batch_limit(tmp_path):
    p = write_lines(tmp_path / "events.jsonl", [{"id": str(i)} for i in range(10)])
    records, offset = Outbox(p).read_batch(limit=4)
    assert len(records) == 4
    assert offset < p.stat().st_size


def make_uploader(tmp_path, **kw):
    return Uploader("https://example.test", "tok", tmp_path, **kw)


def test_offsets_advance_only_after_a_successful_send(tmp_path, monkeypatch):
    write_lines(tmp_path / "events.jsonl", [{"id": "a"}])
    write_lines(tmp_path / "passes.jsonl", [{"hex": "abc"}])
    u = make_uploader(tmp_path)

    monkeypatch.setattr(up, "_post", lambda *a, **k: (_ for _ in ()).throw(OSError("network down")))
    with pytest.raises(OSError):
        u.send_once()
    assert u.events.offset == 0, "a failed upload must not consume the outbox"
    assert u.passes.offset == 0

    sent = {}
    monkeypatch.setattr(up, "_post", lambda url, payload, **k: sent.update(payload) or {"ok": True})
    u.send_once()
    assert u.events.offset > 0 and u.passes.offset > 0
    assert [e["id"] for e in sent["events"]] == ["a"]
    assert [p["hex"] for p in sent["passes"]] == ["abc"]


def test_cursor_survives_a_restart(tmp_path, monkeypatch):
    write_lines(tmp_path / "events.jsonl", [{"id": "a"}])
    monkeypatch.setattr(up, "_post", lambda *a, **k: {"ok": True})
    u = make_uploader(tmp_path)
    u.send_once()
    saved = u.events.offset

    again = make_uploader(tmp_path)          # fresh process, same data dir
    assert again.events.offset == saved
    assert again.send_once() is None, "already-sent records must not be re-sent"


def test_nothing_to_send_makes_no_request(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr(up, "_post", lambda *a, **k: called.append(1) or {"ok": True})
    assert make_uploader(tmp_path).send_once() is None
    assert called == []


def test_token_is_sent_as_a_bearer_header(tmp_path, monkeypatch):
    write_lines(tmp_path / "events.jsonl", [{"id": "a"}])
    seen = {}

    def fake_post(url, payload, token=None, **k):
        seen["url"], seen["token"] = url, token
        return {"ok": True}

    monkeypatch.setattr(up, "_post", fake_post)
    make_uploader(tmp_path).send_once()
    assert seen["url"].endswith("/functions/v1/ingest")
    assert seen["token"] == "tok"


def test_run_stops_permanently_on_a_revoked_token(tmp_path, monkeypatch):
    """401 means the token is gone; retrying forever would be pointless noise."""
    import io
    import urllib.error

    write_lines(tmp_path / "events.jsonl", [{"id": "a"}])
    attempts = []

    def fake_post(*a, **k):
        attempts.append(1)
        raise urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b"revoked"))

    monkeypatch.setattr(up, "_post", fake_post)
    u = make_uploader(tmp_path, interval_s=0.01)
    stop = threading.Event()
    u.run(stop)                               # returns rather than looping
    assert len(attempts) == 1


def test_bodyless_http_error_does_not_kill_the_uploader(tmp_path, monkeypatch):
    """An HTTPError with no readable body must not raise inside the handler."""
    import urllib.error

    write_lines(tmp_path / "events.jsonl", [{"id": "a"}])
    calls = []

    def fake_post(*a, **k):
        calls.append(1)
        raise urllib.error.HTTPError("u", 500, "boom", {}, None)  # fp is None

    monkeypatch.setattr(up, "_post", fake_post)
    u = make_uploader(tmp_path, interval_s=0.01, max_backoff_s=0.02)
    stop = threading.Event()
    threading.Timer(0.25, stop.set).start()
    u.run(stop)                      # must return cleanly, not raise
    assert len(calls) >= 2, "a 500 should be retried, not fatal"
    assert u.events.offset == 0

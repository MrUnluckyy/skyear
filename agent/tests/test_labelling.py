"""Labels, and the path handling that serves audio of somebody's home.

The clip endpoint is the only thing in this project that serves recorded audio
over the network, so its path handling gets the most attention here: an event
id must never be able to become a filesystem path.
"""
import json

import pytest

from skyear import labelling


@pytest.fixture
def data(tmp_path):
    clips = tmp_path / "clips" / "home-1"
    clips.mkdir(parents=True)
    (clips / "a.wav").write_bytes(b"RIFF....WAVE")
    (tmp_path / "events.jsonl").write_text(
        "\n".join(json.dumps(e) for e in [
            {"id": "evt-matched", "start": 100, "duration_s": 30, "clip": "clips/home-1/a.wav",
             "aircraft": [{"flight": "BTI34K", "type": "BCS3", "slant_m": 2500}]},
            {"id": "evt-unmatched", "start": 200, "duration_s": 40, "clip": "clips/home-1/a.wav",
             "aircraft": []},
            {"id": "evt-noclip", "start": 300, "duration_s": 10},
        ]) + "\n"
    )
    return tmp_path


def test_queue_only_offers_events_with_audio(data):
    q = labelling.queue(data)
    assert {i["event_id"] for i in q["items"]} == {"evt-matched", "evt-unmatched"}


def test_unexplained_sounds_come_first(data):
    """They are the class a drone would fall into, so they are worth the most."""
    q = labelling.queue(data)
    assert q["items"][0]["event_id"] == "evt-unmatched"


def test_recording_a_label_then_seeing_it(data):
    labelling.record(data, "evt-unmatched", "scooter")
    q = labelling.queue(data)
    by_id = {i["event_id"]: i for i in q["items"]}
    assert by_id["evt-unmatched"]["label"] == "scooter"
    assert q["counts"]["scooter"] == 1
    assert q["labelled"] == 1


def test_a_correction_overwrites(data):
    labelling.record(data, "evt-unmatched", "vehicle")
    labelling.record(data, "evt-unmatched", "scooter")
    q = labelling.queue(data)
    by_id = {i["event_id"]: i for i in q["items"]}
    assert by_id["evt-unmatched"]["label"] == "scooter"
    assert q["labelled"] == 1, "a correction is not a second label"


def test_labelled_events_sink_to_the_bottom(data):
    labelling.record(data, "evt-unmatched", "wind")
    q = labelling.queue(data)
    assert q["items"][-1]["event_id"] == "evt-unmatched"


# --- clip path handling ----------------------------------------------

def test_clip_resolves_for_a_real_event(data):
    p = labelling.clip_path(data, "evt-matched")
    assert p is not None and p.name == "a.wav"


def test_no_clip_means_none(data):
    assert labelling.clip_path(data, "evt-noclip") is None
    assert labelling.clip_path(data, "does-not-exist") is None


@pytest.mark.parametrize("bad", [
    "../../etc/passwd",
    "../../../../../../etc/shadow",
    "evt/../../../secret",
    "",
    "a" * 200,
    "id with spaces",
    "id\nwith\nnewlines",
])
def test_ids_that_look_like_paths_are_refused(data, bad):
    assert labelling.clip_path(data, bad) is None


def test_a_clip_pointing_outside_the_data_dir_is_refused(tmp_path):
    """Even a trusted event log must not be able to escape the data directory."""
    outside = tmp_path / "secret.wav"
    outside.write_bytes(b"nope")
    d = tmp_path / "data"
    d.mkdir()
    (d / "events.jsonl").write_text(
        json.dumps({"id": "evil", "start": 1, "clip": "../secret.wav"}) + "\n"
    )
    assert labelling.clip_path(d, "evil") is None


def test_unknown_labels_are_not_in_the_vocabulary():
    assert "drone" in labelling.LABELS
    assert "scooter" in labelling.LABELS, "the hard negative must be offerable"
    assert "banana" not in labelling.LABELS

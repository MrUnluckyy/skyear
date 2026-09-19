"""Human labels for recorded sounds, kept on the device with the audio.

WHY THIS LIVES ON THE AGENT

The clips never leave the machine - that is invariant 2, and it is the reason
anyone would run this on a camera pointed at their own home. So labelling has
to happen here too. The audio is served only over the local network, only to a
browser holding the setup token, and only from this process. What leaves, if
the owner ever chooses, is a label: a word attached to an event id.

WHAT IS WORTH LABELLING

Not everything equally. An event ADS-B already explains is nearly free to
label and teaches a classifier little that the transponder did not already
say. The valuable ones are the sounds nothing accounts for, because that is
the class a drone would fall into and it is currently a bag holding scooters,
lorries, construction, rain and aircraft without transponders all at once.
The queue puts those first.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# What a person can say about a sound.
#
# Deliberately not "drone / not drone". The useful distinction for training is
# what the thing actually was, and the hard negatives - a scooter, a lorry -
# matter more than the easy ones, because those are what a rotor detector will
# confuse a drone with.
LABELS = {
    "aircraft": "Aircraft (jet or airliner)",
    "propeller": "Propeller aircraft or helicopter",
    "drone": "Drone",
    "scooter": "Scooter or motorcycle",
    "vehicle": "Car, van or lorry",
    "machinery": "Construction, generator, mower",
    "wind": "Wind",
    "rain": "Rain or hail",
    "voice": "People or animals",
    "other": "Something else",
    "unclear": "Cannot tell",
}

# Labels a classifier must never train on as a positive example of anything.
UNUSABLE = {"unclear"}

_EVENT_ID = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")


def labels_path(data_dir: Path) -> Path:
    return Path(data_dir) / "labels.jsonl"


def _read_labels(data_dir: Path) -> dict[str, dict]:
    """Last write wins, so a correction simply overwrites."""
    out: dict[str, dict] = {}
    path = labels_path(data_dir)
    if not path.is_file():
        return out
    for line in path.read_text(errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and row.get("event_id"):
            out[row["event_id"]] = row
    return out


def _read_events(data_dir: Path) -> list[dict]:
    path = Path(data_dir) / "events.jsonl"
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def clip_path(data_dir: Path, event_id: str) -> Path | None:
    """Resolve an event id to its clip, without trusting the id as a path.

    The id never becomes part of a filesystem path directly. It is looked up
    in the event log and the stored relative path is then confined to the data
    directory, so a crafted id cannot walk out of it.
    """
    if not _EVENT_ID.match(event_id or ""):
        return None
    root = Path(data_dir).resolve()
    for ev in _read_events(data_dir):
        if ev.get("id") != event_id:
            continue
        rel = ev.get("clip")
        if not rel:
            return None
        candidate = (root / rel).resolve()
        if not candidate.is_file():
            return None
        # Confinement check: the resolved path must still be inside data_dir.
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        return candidate
    return None


def queue(data_dir: Path, limit: int = 400) -> dict:
    """Events with a clip, unlabelled first, unexplained before explained."""
    done = _read_labels(data_dir)
    items = []
    for ev in _read_events(data_dir):
        eid = ev.get("id")
        if not eid or not ev.get("clip"):
            continue
        matched = bool(ev.get("aircraft"))
        best = (ev.get("aircraft") or [{}])[0] if matched else {}
        items.append({
            "event_id": eid,
            "start": ev.get("start"),
            "duration_s": ev.get("duration_s"),
            "snr_db": ev.get("snr_db"),
            "dominant_hz": ev.get("dominant_hz"),
            "low_tilt_db": ev.get("low_tilt_db"),
            "n_harmonics": ev.get("n_harmonics"),
            "comb_f0_hz": ev.get("comb_f0_hz"),
            "octave_db": ev.get("octave_db"),
            "likely_wind": bool(ev.get("likely_wind")),
            "truncated": bool(ev.get("truncated")),
            "match_flight": best.get("flight"),
            "match_type": best.get("type"),
            "match_slant_m": best.get("slant_m"),
            "label": (done.get(eid) or {}).get("label"),
        })

    # Newest first within each group, and unexplained before explained.
    items.sort(key=lambda i: (i["label"] is not None,
                              i["match_flight"] is not None,
                              -(i["start"] or 0)))
    counts: dict[str, int] = {}
    for row in done.values():
        counts[row.get("label", "?")] = counts.get(row.get("label", "?"), 0) + 1
    return {
        "labels": LABELS,
        "counts": counts,
        "total": len(items),
        "labelled": sum(1 for i in items if i["label"]),
        "items": items[:limit],
    }


def record(data_dir: Path, event_id: str, label: str, note: str = "") -> int:
    """Append one judgement. Appending rather than rewriting keeps the history
    of corrections, which is itself informative when two people disagree."""
    import time

    path = labels_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps({
            "event_id": event_id,
            "label": label,
            "note": note[:200],
            "at": time.time(),
        }) + "\n")
    return len(_read_labels(data_dir))

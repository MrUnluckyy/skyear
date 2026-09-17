"""Summarise a live run: heard rate by aircraft type and range, and the
event-tilt distribution that separates wind from aircraft.

    .venv/bin/python tools/report.py out
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load(path):
    if not path.is_file():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def bar(n, total, width=28):
    filled = 0 if not total else round(width * n / total)
    return "#" * filled + "." * (width - filled)


def main(data_dir="out"):
    d = Path(data_dir)
    events, passes = load(d / "events.jsonl"), load(d / "passes.jsonl")
    print(f"\n{'='*64}\n  SkyEar run report - {len(events)} events, {len(passes)} passes\n{'='*64}")

    if passes:
        heard = [p for p in passes if p.get("heard")]
        print(f"\nHEARD RATE  {len(heard)}/{len(passes)} = {100*len(heard)/len(passes):.1f}%")

        print("\n  by aircraft type")
        by_type = defaultdict(lambda: [0, 0])
        for p in passes:
            t = by_type[p.get("type") or "?"]
            t[0] += bool(p.get("heard"))
            t[1] += 1
        for t, (h, n) in sorted(by_type.items(), key=lambda kv: -kv[1][1]):
            print(f"    {t:6} {h:3}/{n:<3} {bar(h, n)} {100*h/n:5.1f}%")

        print("\n  by slant range")
        buckets = [(0, 2000), (2000, 4000), (4000, 6000), (6000, 8000), (8000, 99000)]
        for lo, hi in buckets:
            sel = [p for p in passes if lo <= p["min_slant_m"] < hi]
            if not sel:
                continue
            h = sum(bool(p.get("heard")) for p in sel)
            print(f"    {lo//1000}-{hi//1000 if hi<99000 else '+':>2} km {h:3}/{len(sel):<3} "
                  f"{bar(h, len(sel))} {100*h/len(sel):5.1f}%")

        alts = sorted(p["alt_m"] for p in passes if p.get("alt_m") is not None)
        if alts:
            print(f"\n  altitude   min {alts[0]} m   median {alts[len(alts)//2]} m   max {alts[-1]} m")

    if events:
        # Events written before the wind feature have no tilt field. Defaulting
        # them to 0 would make them look like clean aircraft-shaped signals,
        # which is the exact misreading this report exists to prevent.
        scored = [e for e in events if e.get("low_tilt_db") is not None]
        legacy = len(events) - len(scored)
        wind = [e for e in scored if e.get("likely_wind")]
        print(f"\nEVENTS  {len(events)} total"
              + (f", {legacy} with no tilt data (pre-wind-feature, excluded below)" if legacy else ""))
        if scored:
            print(f"        {len(wind)}/{len(scored)} scored events tagged wind "
                  f"({100*len(wind)/len(scored):.0f}%)")
            print("\n  low_tilt_db distribution (>=20 = wind; aircraft should sit well below)")
            edges = [(-999, 0), (0, 10), (10, 15), (15, 18), (18, 20), (20, 25), (25, 999)]
            for lo, hi in edges:
                n = sum(1 for e in scored if lo <= e["low_tilt_db"] < hi)
                if n:
                    label = f"{lo if lo>-999 else '<'}-{hi if hi<999 else '+'}"
                    marker = "  <- wind" if lo >= 20 else ""
                    print(f"    {label:>8} dB  {n:3}  {bar(n, len(scored))}{marker}")

        print("\n  dominant frequency")
        freqs = Counter()
        for e in events:
            f = e.get("dominant_hz", 0)
            freqs["<70 Hz" if f < 70 else "70-120 Hz" if f < 120 else
                  "120-300 Hz" if f < 300 else ">300 Hz"] += 1
        for k in ("<70 Hz", "70-120 Hz", "120-300 Hz", ">300 Hz"):
            if freqs[k]:
                print(f"    {k:>10}  {freqs[k]:3}  {bar(freqs[k], len(events))}")

        matched = [e for e in events if e.get("aircraft")]
        print(f"\n  matched to an aircraft: {len(matched)}/{len(events)}")
        for e in matched[:5]:
            a = e["aircraft"][0]
            tilt = e.get("low_tilt_db")
            tilt_s = f"{tilt:5.1f}" if tilt is not None else "    ?"
            print(f"    {e['start_iso'][11:19]} SNR {e['snr_db']:5.1f} tilt {tilt_s} "
                  f"-> {a.get('flight') or a['hex']} {a.get('type') or '?'} {a['slant_m']/1000:.1f} km")

    if not events and not passes:
        print("\n  no data yet")
    print()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "out")

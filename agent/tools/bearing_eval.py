"""Does comparing camera levels actually say where a sound came from?

ADS-B answers this for free. Every bearing record that matched an aircraft
carries the estimate and the true bearing side by side, so the question is
decidable from data the agent collects on its own.

THE TRAP THIS TOOL EXISTS TO AVOID

A power-weighted mean of camera bearings cannot point outside the arc those
cameras span. Two cameras facing east and south can only ever answer between
east and south. Near an airport most traffic arrives along one approach - which
may well be inside that arc - so the mean error will look impressively small
even if the level comparison contributes nothing whatsoever.

So the number that matters is not the error. It is the error *against a constant
predictor* that ignores the audio entirely and always answers the middle of the
arc. If the estimator does not beat that, the microphones are not telling us
anything and the arc is doing all the work.

This is the same failure as `cpp_db`: a threshold calibrated on synthesis, a
feature that never fired on a real aircraft, and no baseline in sight to reveal
it. A number without a baseline is not evidence.

USAGE

  python tools/bearing_eval.py out/bearings.jsonl
  python tools/bearing_eval.py out/bearings.jsonl --site home-1
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import sys

# Below this there is not enough to conclude anything, and above it there is
# still not enough if every aircraft came from the same direction.
MIN_LABELLED = 200
MIN_QUADRANTS = 3


def signed_diff(a: float, b: float) -> float:
    return (a - b + 180.0) % 360.0 - 180.0


def circular_mean(bearings: list[float]) -> float:
    x = sum(math.cos(math.radians(b)) for b in bearings)
    y = sum(math.sin(math.radians(b)) for b in bearings)
    return math.degrees(math.atan2(y, x)) % 360.0


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    s = sorted(xs)
    k = (len(s) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (k - lo)


def load(path: str) -> list[dict]:
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a partial trailing line while the agent is running
    return records


def report_site(site: str, records: list[dict]) -> None:
    labelled = [r for r in records
                if r.get("true_bearing_deg") is not None and r.get("bearing_deg") is not None]
    crossed = [r for r in labelled if r.get("cameras", 0) >= 2]

    cams = collections.Counter()
    for r in records:
        for h in r.get("heard", []):
            cams[h["camera"]] = h["bearing_deg"]

    print(f"\n=== {site} ===")
    print(f"  cameras aimed  : " + ", ".join(f"{c} {b:.0f}°" for c, b in sorted(cams.items())))
    print(f"  records        : {len(records)}  ({len(labelled)} explained by ADS-B, "
          f"{len(crossed)} of those heard by 2+ cameras)")

    if not crossed:
        print("  Nothing heard by two cameras at once yet. A bearing from one "
              "camera is its own direction and cannot be scored.")
        return

    errors = [abs(signed_diff(r["bearing_deg"], r["true_bearing_deg"])) for r in crossed]
    truths = [r["true_bearing_deg"] for r in crossed]

    # The predictor that ignores the audio: always answer the middle of where
    # this site's estimates can land.
    centre = circular_mean([r["bearing_deg"] for r in crossed])
    baseline = [abs(signed_diff(centre, t)) for t in truths]

    quadrants = {int(t % 360 // 90) for t in truths}
    bias = circular_mean([signed_diff(r["bearing_deg"], r["true_bearing_deg"]) % 360
                          for r in crossed])
    bias = signed_diff(bias, 0.0)

    print(f"  arc spanned    : {percentile([r.get('arc_deg', 0.0) for r in crossed], 50):.0f}°")
    print(f"  median |error| : {percentile(errors, 50):6.1f}°   "
          f"p90 {percentile(errors, 90):.1f}°")
    print(f"  constant answer: {percentile(baseline, 50):6.1f}°   "
          f"p90 {percentile(baseline, 90):.1f}°   <- beat this or the audio is not helping")
    print(f"  systematic bias: {bias:+.1f}°  (what per-site calibration would remove)")
    print(f"  truth covers   : {len(quadrants)} of 4 quadrants")

    gain = percentile(baseline, 50) - percentile(errors, 50)
    if gain > 5.0:
        print(f"  --> the level comparison is worth {gain:.1f}° of median error here.")
    elif gain > 0:
        print(f"  --> only {gain:.1f}° better than answering the same thing every "
              "time. Not yet evidence of anything.")
    else:
        print("  --> NO BETTER than ignoring the audio. Whatever this site is "
              "measuring, it is not direction.")

    if len(crossed) < MIN_LABELLED or len(quadrants) < MIN_QUADRANTS:
        print(f"  No calibration from this: needs {MIN_LABELLED}+ crossed records "
              f"over {MIN_QUADRANTS}+ quadrants, and a bias fitted to aircraft that "
              "all came from one direction would be fitted to the approach path, "
              "not to the site.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="bearings.jsonl from the agent's data directory")
    ap.add_argument("--site", help="only this site")
    args = ap.parse_args()

    records = load(args.path)
    if not records:
        print("No bearing records yet. Aim two cameras at one address and wait "
              "for something to fly over.")
        return 1

    by_site = collections.defaultdict(list)
    for r in records:
        by_site[r.get("site", "?")].append(r)
    for site in sorted(by_site):
        if args.site and site != args.site:
            continue
        report_site(site, by_site[site])
    return 0


if __name__ == "__main__":
    sys.exit(main())

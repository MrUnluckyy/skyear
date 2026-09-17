# SkyEar web app (not started)

React + TypeScript on Vercel, MapLibre GL with OpenStreetMap tiles.

## Planned layers
1. Live ADS-B aircraft.
2. Approximate sensor positions (never exact — see invariant 4 in `../CLAUDE.md`).
3. Detection lines: sensor → matched aircraft.
4. Event feed.
5. Per-sensor stats: detection rate, max range per aircraft type.

## Open
- UI language: Lithuanian, English, or both.
- Project name — "SkyEar" is a working title.
- The site must never ask for a camera IP, username, or password. Onboarding is
  local to the agent; the cloud sees only a pairing code.

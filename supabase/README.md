# SkyEar backend (not started)

Postgres + PostGIS on Supabase. Row-level security, Edge Functions, Realtime,
private Storage.

## Planned schema
| Table | Purpose |
|---|---|
| `devices` | owner, **token hash** (never the token), approximate location, status |
| `sensors` | device ref, exact location **kept private**, public geohash |
| `detections` | event fields + matched aircraft |
| `passes` | heard / not-heard record per nearby aircraft |
| `pairing_codes` | short-lived codes that trade for a device token |

## Rules
- **RLS:** owners see only their own devices. Public reads hit a coarse view
  that exposes approximate location and never exact coordinates.
- **Edge Function `ingest`:** device-token auth, schema validation, rate limiting.
- **Realtime:** broadcast new detections to the map.
- Public drone detections are **delayed or coarsened**; the map must not reveal
  coverage gaps. See invariant 4 in `../CLAUDE.md`.
- Storage stays private. Clips arrive only on explicit opt-in, speech-filtered
  on the device first.

## Open
- Retention policy per table.
- Whether `passes` belongs in Postgres or stays device-local and aggregated.

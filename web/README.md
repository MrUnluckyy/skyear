# SkyEar web

Deployed at [skyear.lt](https://skyear.lt) (Vercel project `skyear`, region `fra1`).
`skyear.vercel.app` still resolves and is kept as a fallback.

**The project's Root Directory must be `web`.** Without it, git-triggered builds run
from the repo root, fail with "Couldn't find any `pages` or `app` directory", and every
push leaves a failed production deployment behind - which among other things blocks
attaching a domain.

Auth redirect URLs must list every origin the app is served from - the
production domain and `http://localhost:3001/**` for development. A magic
link to an origin missing from that allowlist silently bounces.

Next.js 16 (App Router) + TypeScript + Tailwind, MapLibre GL with OpenStreetMap
raster tiles. Deploys to Vercel.

```bash
cp .env.example .env.local     # fill in from the Supabase dashboard
npm install
npm run dev
```

## Layout
```
app/page.tsx          client boundary; loads the map with ssr:false
app/api/adsb/route.ts server-side ADS-B proxy (cache + backoff)
components/SkyMap.tsx map, layers, realtime subscription
lib/supabase.ts       browser client (publishable key)
lib/types.ts          row shapes for the public_* views
```

## Why the ADS-B proxy exists
Browsers must never call `adsb.lol` directly. One agent polling at 5 s was
enough to get HTTP 429 during testing, so N visitors would be an instant ban -
and every request would leak that visitor's area of interest. The proxy makes
one cached upstream call for everyone, collapses concurrent misses, backs off
exponentially on failure, and serves stale data rather than blanking the map.

`airplanes.live` is **not** a drop-in fallback: it returns 403 and requires you
to email them describing the project. The durable fix is a local RTL-SDR running
`readsb`, which removes the dependency and the rate limit entirely.

## Basemaps and the MapLibre worker
CARTO vector styles (Dark Matter / Positron), keyless and free with attribution,
with a light/dark toggle. Their **raster** tiles now stamp "API KEY REQUIRED"
across every tile, so vector is the only free option.

`maplibre-gl` must stay on **v6 or newer**: every earlier release carries a
critical XSS advisory (GHSA-jrc7-96c5-q579) in `DOM.sanitize`, which
style-supplied attribution HTML passes through. Do not downgrade.

v6 loads its worker as a separate ES module that does not resolve under
Turbopack, and MapLibre fetches vector tiles *inside* that worker - so without
a fix the style, sprite and TileJSON all load and then no tile is ever
requested, silently. `scripts/copy-maplibre-worker.mjs` copies the worker into
`public/` and `setWorkerUrl()` points at it, bypassing the bundler. The copy
runs automatically on `predev` and `prebuild`.

Two other silent failures, now guarded in code:
- `maplibre-gl.css` forces `position: relative` on its container, which
  overrides an `absolute inset-0` and collapses the map to **zero height** -
  producing exactly the same symptom as the worker bug. Positioning lives on a
  wrapper; the map owns a plain full-size box. This one was originally
  misdiagnosed as a v6 problem and caused an unnecessary downgrade.
- The map is built while the `dynamic()` placeholder is still swapping out, so
  a `ResizeObserver` calls `map.resize()`.
- `map.on("error")` is wired up, because MapLibre otherwise swallows style and
  tile failures entirely.

## Privacy
The page only ever reads `public_sensors` and `public_detections`. Exact sensor
coordinates are not in those views - the database snaps them to a ~1 km grid -
and drone detections are withheld for 30 minutes with their match fields
stripped. The publishable key is public by design; RLS is what protects data.
Never put a `service_role` key in this app.

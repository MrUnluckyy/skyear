# SkyEar web

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

## Basemaps and the maplibre-gl version pin
CARTO vector styles (Dark Matter / Positron), keyless and free with attribution,
with a light/dark toggle. Their **raster** tiles now stamp "API KEY REQUIRED"
across every tile, so vector is the only free option.

`maplibre-gl` is pinned to **v5**, deliberately. On v6.10.0 no vector tile ever
renders here: v6 loads its worker as a separate ES module that does not start
under Turbopack, and because MapLibre fetches vector tiles *inside* that worker,
the failure is silent - style, sprite and TileJSON all load, then nothing is
requested. Raster tiles, fetched on the main thread, keep working, which makes
it look like a style problem. v5 inlines its worker. Re-test before upgrading.

Two other things that cost time and are now guarded in code:
- the map is built while the `dynamic()` placeholder is still swapping out, so
  its container can be zero-height for a frame - a `ResizeObserver` calls
  `map.resize()`, without which no tiles load;
- `map.on("error")` is wired up, because MapLibre otherwise swallows style and
  tile failures entirely.

## Privacy
The page only ever reads `public_sensors` and `public_detections`. Exact sensor
coordinates are not in those views - the database snaps them to a ~1 km grid -
and drone detections are withheld for 30 minutes with their match fields
stripped. The publishable key is public by design; RLS is what protects data.
Never put a `service_role` key in this app.

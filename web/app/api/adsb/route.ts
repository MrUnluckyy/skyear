import { NextResponse } from "next/server";
import type { Aircraft } from "@/lib/types";

/**
 * Server-side ADS-B proxy.
 *
 * Browsers must never call adsb.lol directly: one agent polling at 5 s was
 * enough to earn HTTP 429 during testing, so N map visitors would be an instant
 * ban - and each request would leak that visitor's area of interest. One
 * cached fetch serves everyone.
 *
 * The server decides the area, not the browser. When the query string chose
 * it, alternating two locations missed the cache on every request and sent
 * each one straight upstream, which is exactly the ban this exists to prevent.
 */

/*
 * Two providers, on the identical readsb schema.
 *
 * Measured 2026-09-23 from one client at a 10 s poll, 48 requests each:
 * adsb.lol returned 429 for 8 of them and adsb.fi for none. That is the
 * provider shedding load, not us exceeding a rate - we are two orders of
 * magnitude under its burst limit - so polling slower cannot fix it. With one
 * provider a shed request on a cold cache blanks the map, and the backoff then
 * keeps it blank for minutes. The agent rotates for the same reason.
 *
 * Sticky: stay on whichever answered last rather than leading with the one
 * that just refused.
 */
const PROVIDERS = [
  "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}",
  "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}",
];
let provider = 0;
const MIN_INTERVAL_MS = 10_000; // never hit upstream faster than this
const FT_TO_M = 0.3048;

/**
 * What the map covers. adsb.lol caps a query at 250 nm, so a new country is a
 * new region rather than a wider circle - and each region is one more upstream
 * request per interval, so add them as sensors arrive there, not before.
 */
const REGIONS = [
  // The centre of Lithuania. Its furthest borders are 101 nm away, so 120 nm
  // covers the whole country with room to see aircraft coming, and takes in
  // the Riga and Kaliningrad approaches on the way.
  { name: "Lithuania", lat: 55.17, lon: 23.89, nm: 120 },
];

type Cache = { at: number; data: Aircraft[] };
let cache: Cache | null = null;
let inflight: Promise<Aircraft[]> | null = null;

// Same discipline as the agent: retrying a 429 at the normal rate is how a free
// community API earns an IP ban. Back off, and serve stale data meanwhile.
let failures = 0;
let nextAllowedAt = 0;
const MAX_BACKOFF_MS = 300_000;

function backoffMs(n: number) {
  return Math.min(MIN_INTERVAL_MS * 2 ** n, MAX_BACKOFF_MS);
}

function parse(json: unknown): Aircraft[] {
  // adsb.lol calls the array `ac`, adsb.fi calls it `aircraft`. Same rows.
  const j = json as { ac?: unknown[]; aircraft?: unknown[] };
  const planes = j?.ac ?? j?.aircraft ?? [];
  const out: Aircraft[] = [];
  for (const raw of planes) {
    const a = raw as Record<string, unknown>;
    if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    const altRaw = a.alt_geom ?? a.alt_baro;
    const alt = altRaw === "ground" ? 0 : typeof altRaw === "number" ? altRaw : null;
    if (alt === null) continue;
    out.push({
      hex: String(a.hex ?? "").toLowerCase(),
      flight: typeof a.flight === "string" ? a.flight.trim() || null : null,
      reg: typeof a.r === "string" ? a.r.trim() || null : null,
      type: typeof a.t === "string" ? a.t : null,
      lat: a.lat,
      lon: a.lon,
      alt_m: Math.round(alt * FT_TO_M),
      track: typeof a.track === "number" ? a.track : null,
    });
  }
  return out;
}

async function fetchRegion(r: (typeof REGIONS)[number]): Promise<Aircraft[]> {
  let last = "";
  for (let attempt = 0; attempt < PROVIDERS.length; attempt += 1) {
    const i = (provider + attempt) % PROVIDERS.length;
    const target = PROVIDERS[i]
      .replace("{lat}", r.lat.toFixed(4))
      .replace("{lon}", r.lon.toFixed(4))
      .replace("{nm}", String(r.nm));
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": "skyear-web/0.1" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      const data = parse(await res.json());
      provider = i;
      return data;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  // Only now is it worth backing off: every provider refused.
  throw new Error(last || "no adsb provider answered");
}

export async function GET() {
  const fresh = cache && Date.now() - cache.at < MIN_INTERVAL_MS;
  if (fresh && cache) {
    return NextResponse.json(
      { aircraft: cache.data, cached: true, age_ms: Date.now() - cache.at },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  }

  // While backing off, never touch upstream - serve whatever we last had.
  if (Date.now() < nextAllowedAt && !inflight) {
    return NextResponse.json({
      aircraft: cache?.data ?? [],
      cached: true,
      stale: true,
      backoff_ms_remaining: nextAllowedAt - Date.now(),
    });
  }

  // Collapse concurrent misses into a single upstream request.
  if (!inflight) {
    inflight = Promise.all(REGIONS.map(fetchRegion))
      .then((lists) => {
        // Regions overlap at their edges; an aircraft there is one aircraft.
        const byHex = new Map<string, Aircraft>();
        for (const a of lists.flat()) byHex.set(a.hex, a);
        const data = [...byHex.values()];
        cache = { at: Date.now(), data };
        failures = 0;
        nextAllowedAt = 0;
        return data;
      })
      .catch((err) => {
        failures += 1;
        nextAllowedAt = Date.now() + backoffMs(failures);
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    const data = await inflight;
    return NextResponse.json(
      { aircraft: data, cached: false },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  } catch (err) {
    // Serve stale rather than nothing - a rate limit upstream should not blank
    // the map for everyone.
    if (cache) {
      return NextResponse.json({
        aircraft: cache.data,
        cached: true,
        stale: true,
        age_ms: Date.now() - cache.at,
      });
    }
    // No cache to fall back on: report the failure but keep the shape stable so
    // the map renders empty rather than breaking.
    return NextResponse.json(
      {
        aircraft: [],
        error: String(err instanceof Error ? err.message : err),
        retry_after_ms: Math.max(0, nextAllowedAt - Date.now()),
      },
      { status: 200 }
    );
  }
}

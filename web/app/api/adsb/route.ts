import { NextResponse } from "next/server";
import type { Aircraft } from "@/lib/types";

/**
 * Server-side ADS-B proxy.
 *
 * Browsers must never call adsb.lol directly: one agent polling at 5 s was
 * enough to earn HTTP 429 during testing, so N map visitors would be an instant
 * ban - and each request would leak that visitor's area of interest. One
 * cached fetch serves everyone.
 */

const UPSTREAM = "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}";
const MIN_INTERVAL_MS = 10_000; // never hit upstream faster than this
const FT_TO_M = 0.3048;

type Cache = { at: number; data: Aircraft[]; key: string };
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
  const planes = (json as { ac?: unknown[] })?.ac ?? [];
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
      type: typeof a.t === "string" ? a.t : null,
      lat: a.lat,
      lon: a.lon,
      alt_m: Math.round(alt * FT_TO_M),
      track: typeof a.track === "number" ? a.track : null,
    });
  }
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat") ?? 54.65);
  const lon = Number(url.searchParams.get("lon") ?? 25.34);
  const nm = Math.min(Number(url.searchParams.get("nm") ?? 25), 50);
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${nm}`;

  const fresh = cache && cache.key === key && Date.now() - cache.at < MIN_INTERVAL_MS;
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
    inflight = (async () => {
      const target = UPSTREAM.replace("{lat}", lat.toFixed(4))
        .replace("{lon}", lon.toFixed(4))
        .replace("{nm}", String(Math.round(nm)));
      const res = await fetch(target, {
        headers: { "User-Agent": "skyear-web/0.1" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      return parse(await res.json());
    })()
      .then((data) => {
        cache = { at: Date.now(), data, key };
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

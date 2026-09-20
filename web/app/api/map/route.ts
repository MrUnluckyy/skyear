import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * Everything the map draws, in one cached response.
 *
 * The browser used to query the six public views directly, which meant every
 * visitor was ~24 queries a minute against the database: fine for a handful of
 * people, and an outage waiting to happen the first time a link does well. The
 * data is identical for everyone - these are public, coarsened views - so it
 * is fetched once per interval and served from Vercel's edge to everyone else,
 * the same arrangement /api/adsb uses for aircraft.
 *
 * Reads go through the publishable key, so RLS and the public_* views still
 * decide what is visible. This route can see nothing an anonymous browser
 * could not.
 */
export const dynamic = "force-dynamic";

const FRESH_S = 25; // the agents upload every 30 s, so this is the real update rate
const STALE_S = 60;

function client() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function GET() {
  const supabase = client();
  const [sensors, detections, stats, types, spectrum, conditions] = await Promise.all([
    // Ordered, always. The numbering people see is positional, so an
    // unordered result renames every sensor between polls.
    supabase.from("public_sensors").select("*").order("id"),
    supabase
      .from("public_detections")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(60),
    supabase.from("public_sensor_stats").select("*"),
    supabase.from("public_type_stats").select("*").order("passes", { ascending: false }),
    supabase.from("public_spectrum_baseline").select("*"),
    supabase.from("public_sensor_conditions").select("*"),
  ]);

  const failed = sensors.error ?? detections.error ?? stats.error;
  return NextResponse.json(
    {
      sensors: sensors.data ?? [],
      detections: detections.data ?? [],
      stats: stats.data ?? [],
      types: types.data ?? [],
      spectrum: spectrum.data ?? [],
      conditions: conditions.data ?? [],
      error: failed?.message ?? null,
    },
    {
      headers: {
        // A failure is cached briefly too. Serving it uncached would send
        // every visitor's next poll straight through to a database that is
        // already struggling, which is how a wobble becomes an outage.
        "cache-control": failed
          ? "public, s-maxage=5"
          : `public, s-maxage=${FRESH_S}, stale-while-revalidate=${STALE_S}`,
      },
    }
  );
}

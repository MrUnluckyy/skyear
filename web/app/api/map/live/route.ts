import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * Sensor liveness on its own, polled faster than the rest of the map.
 *
 * The agent heartbeats every 10 s and a "hearing something right now" badge is
 * worthless if it lags, so this is separate from /api/map rather than making
 * the whole bundle refresh at this rate. Cached for a few seconds, which keeps
 * the badge honest while collapsing any number of visitors into one query.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await supabase.from("public_sensors").select("*").order("id");

  return NextResponse.json(
    { sensors: data ?? [], error: error?.message ?? null },
    {
      headers: {
        "cache-control": error
          ? "public, s-maxage=5"
          : "public, s-maxage=4, stale-while-revalidate=20",
      },
    }
  );
}

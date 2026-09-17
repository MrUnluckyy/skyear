/**
 * Trade a short-lived pairing code for a device token.
 *
 * The code is the only bearer of authority here, so it is single-use, expires
 * quickly, and is consumed atomically before any token is issued. The cloud
 * never learns a camera address or password - see invariant 1 in CLAUDE.md. The
 * location supplied is already coarsened by the agent.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Camera = {
  camera_id: string;
  lat: number;
  lon: number;
  elevation_m?: number;
  mount_height_m?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { code?: string; name?: string; agent_version?: string; cameras?: Camera[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const code = (body.code ?? "").trim().toUpperCase();
  const cameras = body.cameras ?? [];
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return json({ error: "invalid code" }, 400);
  if (cameras.length === 0 || cameras.length > 16) return json({ error: "cameras required" }, 400);

  for (const c of cameras) {
    if (
      typeof c.camera_id !== "string" || !c.camera_id ||
      typeof c.lat !== "number" || typeof c.lon !== "number" ||
      Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180
    ) {
      return json({ error: `invalid camera: ${c.camera_id ?? "?"}` }, 400);
    }
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Consume the code first. The `is null` guard makes this atomic: a second
  // request for the same code matches no row and gets nothing.
  const { data: claimed, error: claimErr } = await admin
    .from("pairing_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("code, owner_id")
    .maybeSingle();

  if (claimErr) return json({ error: "pairing failed" }, 500);
  if (!claimed) return json({ error: "code invalid, expired, or already used" }, 400);

  const token = newToken();
  const token_hash = await sha256Hex(token);

  // Device point is the first camera, rounded hard - the cloud has no use for
  // a precise position and should not hold one.
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const { data: device, error: devErr } = await admin
    .from("devices")
    .insert({
      owner_id: claimed.owner_id,
      name: (body.name ?? "SkyEar agent").slice(0, 80),
      token_hash,
      approx_point: `SRID=4326;POINT(${round3(cameras[0].lon)} ${round3(cameras[0].lat)})`,
      status: "active",
      agent_version: (body.agent_version ?? "").slice(0, 32) || null,
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (devErr || !device) {
    await admin.from("pairing_codes").update({ used_at: null }).eq("code", code);
    return json({ error: "could not create device" }, 500);
  }

  const { error: sensorErr } = await admin.from("sensors").insert(
    cameras.map((c) => ({
      device_id: device.id,
      camera_id: c.camera_id,
      exact_point: `SRID=4326;POINT(${c.lon} ${c.lat})`,
      elevation_m: c.elevation_m ?? 0,
      mount_height_m: c.mount_height_m ?? 0,
    })),
  );

  if (sensorErr) {
    await admin.from("devices").delete().eq("id", device.id);
    await admin.from("pairing_codes").update({ used_at: null }).eq("code", code);
    return json({ error: "could not create sensors" }, 500);
  }

  await admin.from("pairing_codes").update({ device_id: device.id }).eq("code", code);

  // The token is returned exactly once; only its hash is stored.
  return json({ device_id: device.id, token, cameras: cameras.map((c) => c.camera_id) });
});

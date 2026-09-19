/**
 * Accept detections and passes from a paired agent.
 *
 * Auth is a device token, never a user session: the agent has no account and
 * cannot read anything back. Writes land on the service role, so no client
 * insert policy exists on these tables at all.
 *
 * Ingest is idempotent by database constraint - unique (device_id, event_id)
 * and (device_id, hex, closest_at) - so a retried upload after a dropped
 * connection cannot duplicate rows. The agent is free to re-send.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BATCH = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const iso = (t: unknown) =>
  typeof t === "number" && isFinite(t) ? new Date(t * 1000).toISOString() : null;

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

type AgentEvent = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "missing device token" }, 401);

  type CameraDecl = {
    camera_id?: string;
    lat?: number;
    lon?: number;
    elevation_m?: number;
    mount_height_m?: number;
  };

  let body: {
    events?: AgentEvent[];
    passes?: AgentEvent[];
    status?: Record<string, AgentEvent>;
    cameras?: CameraDecl[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const events = body.events ?? [];
  const passes = body.passes ?? [];
  if (events.length + passes.length > MAX_BATCH) {
    return json({ error: `batch too large, max ${MAX_BATCH}` }, 413);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: device } = await admin
    .from("devices")
    .select("id, status")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();

  // Same response for unknown and revoked, so a probe learns nothing.
  if (!device || device.status !== "active") return json({ error: "unauthorized" }, 401);

  const { data: sensorRows } = await admin
    .from("sensors")
    .select("id, camera_id")
    .eq("device_id", device.id);

  const sensorByCamera = new Map((sensorRows ?? []).map((s) => [s.camera_id, s.id]));
  const skipped: string[] = [];
  const registered: string[] = [];

  /*
   * Converge to the camera set the agent says it has.
   *
   * Sensor rows used to be created only inside the pair function, at pairing
   * time. A camera added afterwards had nowhere to land: the wizard saved it,
   * the agent listened to it and uploaded its events, and this function could
   * not map the camera_id to a sensor - so every event went into `skipped` and
   * was discarded. Nothing logged it and nothing surfaced it. Multi-camera was
   * advertised in config.example.yaml and quietly did not work.
   *
   * The agent is the authority on which cameras it has, so the server follows
   * it. This also repairs setups that are already broken, with no user action.
   *
   * Only additions. A camera disappearing from the declaration does not delete
   * a sensor - that would throw away its history the first time somebody
   * commented out a line, and removal belongs in the owner's hands, not in a
   * config file edit.
   */
  const declared = Array.isArray(body.cameras) ? body.cameras.slice(0, 16) : [];
  const missing = declared.filter(
    (c) =>
      typeof c.camera_id === "string" &&
      c.camera_id.length > 0 &&
      c.camera_id.length <= 64 &&
      !sensorByCamera.has(c.camera_id) &&
      typeof c.lat === "number" && Math.abs(c.lat) <= 90 &&
      typeof c.lon === "number" && Math.abs(c.lon) <= 180,
  );

  if (missing.length) {
    const { data: created, error } = await admin
      .from("sensors")
      .insert(
        missing.map((c) => ({
          device_id: device.id,
          camera_id: c.camera_id,
          exact_point: `SRID=4326;POINT(${c.lon} ${c.lat})`,
          elevation_m: typeof c.elevation_m === "number" ? c.elevation_m : 0,
          mount_height_m: typeof c.mount_height_m === "number" ? c.mount_height_m : 0,
        })),
      )
      .select("id, camera_id");
    if (!error) {
      for (const row of created ?? []) {
        sensorByCamera.set(row.camera_id, row.id);
        registered.push(row.camera_id);
      }
    }
  }

  const detectionRows = [];
  for (const e of events) {
    const sensor_id = sensorByCamera.get(String(e.camera ?? ""));
    const started_at = iso(e.start);
    const ended_at = iso(e.end);
    if (!sensor_id || !started_at || !ended_at || typeof e.id !== "string") {
      skipped.push(String(e.id ?? "?"));
      continue;
    }
    const best = Array.isArray(e.aircraft) && e.aircraft.length
      ? (e.aircraft[0] as Record<string, unknown>)
      : null;
    detectionRows.push({
      event_id: e.id,
      sensor_id,
      device_id: device.id,
      // The agent ships a wind flag, not a classification. Anything it believes
      // is wind is stored as noise so the public view never shows it.
      class: e.likely_wind ? "noise" : "unknown",
      started_at,
      ended_at,
      duration_s: num(e.duration_s) ?? 0,
      peak_db: num(e.peak_db),
      floor_db: num(e.floor_db),
      snr_db: num(e.snr_db),
      dominant_hz: num(e.dominant_hz),
      low_tilt_db: num(e.low_tilt_db),
      // Periodicity. Stored for every event, noise included: a labelled corpus
      // of what the wind sounds like here is what a classifier needs as
      // negatives.
      cpp_db: num(e.cpp_db),
      harmonic: Boolean(e.harmonic),
      f0_hz: num(e.f0_hz),
      likely_wind: Boolean(e.likely_wind),
      // The agent knows its own max_event_s; the server must not guess it from
      // a hard-coded duration. Absent on older agents, which is what the
      // backfill in migration 0012 covers.
      truncated: Boolean(e.truncated),
      // Narrowband rotor structure. Stored for every event including noise: a
      // labelled record of what the wind and the road sound like here is what
      // any future classifier needs as negatives, and what the threshold for a
      // red dot will eventually have to be set against.
      comb_db: num(e.comb_db),
      comb_f0_hz: num(e.comb_f0_hz),
      n_harmonics: num(e.n_harmonics),
      tonal_db: num(e.tonal_db),
      octave_db: e.octave_db ?? null,
      match_hex: best ? String(best.hex ?? "") || null : null,
      match_flight: best ? (best.flight as string | null) ?? null : null,
      match_type: best ? (best.type as string | null) ?? null : null,
      match_slant_m: best ? num(best.slant_m) : null,
      match_alt_m: best ? num(best.alt_m) : null,
      match_bearing: best ? num(best.bearing_deg) : null,
      match_delay_s: best ? num(best.delay_s) : null,
      has_clip: Boolean(e.clip),
    });
  }

  const passRows = [];
  for (const p of passes) {
    const sensor_id = sensorByCamera.get(String(p.camera ?? ""));
    const closest_at = iso(p.closest_time);
    if (!sensor_id || !closest_at || typeof p.hex !== "string") continue;
    passRows.push({
      sensor_id,
      device_id: device.id,
      hex: p.hex,
      flight: (p.flight as string | null) ?? null,
      aircraft_type: (p.type as string | null) ?? null,
      registration: (p.reg as string | null) ?? null,
      closest_at,
      min_slant_m: num(p.min_slant_m) ?? 0,
      alt_m: num(p.alt_m),
      elevation_deg: num(p.elevation_deg),
      heard: Boolean(p.heard),
      event_ids: Array.isArray(p.event_ids) ? p.event_ids : [],
    });
  }

  let detections = 0;
  let passCount = 0;

  if (detectionRows.length) {
    const { error, count } = await admin
      .from("detections")
      .upsert(detectionRows, { onConflict: "device_id,event_id", ignoreDuplicates: true, count: "exact" });
    if (error) return json({ error: "detection insert failed", detail: error.message }, 400);
    detections = count ?? detectionRows.length;
  }

  if (passRows.length) {
    const { error, count } = await admin
      .from("passes")
      .upsert(passRows, { onConflict: "device_id,hex,closest_at", ignoreDuplicates: true, count: "exact" });
    if (error) return json({ error: "pass insert failed", detail: error.message }, 400);
    passCount = count ?? passRows.length;
  }

  /*
   * Live listening state. Overwritten in place per sensor, never appended, so
   * it cannot grow and keeps no record of when a sensor was quiet. This is what
   * lets the map show what is being heard *now* - the event stream only reports
   * a sound once it has finished.
   */
  let live = 0;
  const statusRows = [];
  for (const [camera, raw] of Object.entries(body.status ?? {})) {
    const sensor_id = sensorByCamera.get(camera);
    if (!sensor_id) continue;
    statusRows.push({
      sensor_id,
      device_id: device.id,
      level_db: num(raw.level_db),
      floor_db: num(raw.floor_db),
      excess_db: num(raw.excess_db),
      rising: Boolean(raw.rising),
      event_active: Boolean(raw.event_active),
      event_s: num(raw.event_s) ?? 0,
      warm: Boolean(raw.warm),
      // Null when the agent does not report it at all. Coercing absence to
      // false made every agent older than this field look broken, while it sat
      // there reporting the noise floor it had just measured.
      audio: typeof raw.audio === "boolean" ? raw.audio : null,
      reported_at: new Date().toISOString(),
    });
  }
  if (statusRows.length) {
    const { error } = await admin
      .from("sensor_status")
      .upsert(statusRows, { onConflict: "sensor_id" });
    if (!error) live = statusRows.length;
  }

  await admin
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", device.id);

  // `registered` and `skipped` both travel back so the agent can log them.
  // A silent discard is how a second camera streamed into nothing for days.
  return json({
    ok: true,
    detections,
    passes: passCount,
    live,
    registered,
    skipped: skipped.slice(0, 10),
  });
});

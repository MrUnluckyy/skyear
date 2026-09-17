"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/lib/supabase";
import {
  PHASE_LABEL,
  noiseBaseline,
  observedWindow,
  sensorPhase,
  type Aircraft,
  type PublicDetection,
  type PublicSensor,
  type SensorStats,
  type TypeStats,
} from "@/lib/types";
import { DetectionRow, OctaveBars, SensorBeacon } from "./SensorBeacon";

/** Vilnius old town. A default centre should be a city, not a contributor's street. */
/**
 * v6 loads its worker as a separate ES module that does not resolve under
 * Turbopack, and vector tiles are fetched *inside* that worker - so without
 * this the style loads, layers attach, and no tile is ever requested, silently.
 * v6 is required: every earlier release carries a critical XSS advisory
 * (GHSA-jrc7-96c5-q579) in DOM.sanitize, which style-supplied attribution HTML
 * passes through.
 */
setWorkerUrl("/maplibre-gl-worker.mjs");

const VILNIUS: [number, number] = [25.2797, 54.6872];

/**
 * CARTO vector basemaps: modern, keyless, free with attribution.
 *
 * Vector, not raster: CARTO's raster tiles now stamp "API KEY REQUIRED" across
 * every tile, so the vector styles are the only free option.
 *
 * Pinned to maplibre-gl v5 deliberately. On v6.10.0 vector tiles never render
 * here: v6 loads its worker as a separate ES module that does not start under
 * Turbopack, and since MapLibre fetches vector tiles *inside* that worker, the
 * failure is silent - style, sprite and TileJSON all load, then no tile is ever
 * requested. v5 inlines its worker and just works.
 */
type Theme = "dark" | "light";

const STYLES: Record<Theme, string> = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

const FROST = "#c9e2f0";
const GROUND = "#55697a";

function aircraftFeatures(list: Aircraft[]) {
  return {
    type: "FeatureCollection" as const,
    features: list.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
      properties: {
        label: a.flight ?? a.hex,
        alt: a.alt_m,
        onGround: a.alt_m <= 0,
      },
    })),
  };
}

export default function SkyMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [sensors, setSensors] = useState<PublicSensor[]>([]);
  const [detections, setDetections] = useState<PublicDetection[]>([]);
  const [stats, setStats] = useState<SensorStats[]>([]);
  const [types, setTypes] = useState<TypeStats[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Screen positions for the DOM overlay, reprojected as the map moves.
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});
  // Bumped when a sensor reports something new, which drives the arrival flare.
  const [flares, setFlares] = useState<Record<string, number>>({});
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);

  const latest = useRef({ aircraft });
  latest.current = { aircraft };
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  const addLayers = useCallback((m: MapLibreMap, forTheme: Theme) => {
    const halo = forTheme === "dark" ? "#080d12" : "#ffffff";
    const text = forTheme === "dark" ? "#c9e2f0" : "#1f2933";

    if (!m.getSource("aircraft")) {
      m.addSource("aircraft", { type: "geojson", data: aircraftFeatures(latest.current.aircraft) });
    }
    if (!m.getLayer("aircraft-dot")) {
      m.addLayer({
        id: "aircraft-dot",
        type: "circle",
        source: "aircraft",
        paint: {
          "circle-radius": ["case", ["get", "onGround"], 2.5, 4.5],
          "circle-color": ["case", ["get", "onGround"], GROUND, FROST],
          "circle-stroke-width": ["case", ["get", "onGround"], 0, 1],
          "circle-stroke-color": halo,
          "circle-opacity": ["case", ["get", "onGround"], 0.5, 1],
        },
      });
    }
    if (!m.getLayer("aircraft-label")) {
      m.addLayer({
        id: "aircraft-label",
        type: "symbol",
        source: "aircraft",
        filter: ["!", ["get", "onGround"]],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Regular"],
          "text-size": 10,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-letter-spacing": 0.04,
        },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.6 },
      });
    }
  }, []);

  // --- map ----------------------------------------------------------------
  useEffect(() => {
    if (map.current || !container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: STYLES.dark,
      center: VILNIUS,
      zoom: 10.2,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");

    m.on("error", (e) => {
      const msg = (e as unknown as { error?: { message?: string } }).error?.message ?? String(e);
      console.error("[skyear] map error:", msg);
    });

    // Built while the dynamic-import placeholder is still swapping out, so the
    // container can be zero-height for a frame. Without this, the style loads,
    // layers attach, and not one tile is ever requested.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);

    m.on("style.load", () => {
      addLayers(m, themeRef.current);
      map.current = m;
      setReady(true);
    });

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, [addLayers]);

  useEffect(() => {
    map.current?.setStyle(STYLES[theme]);
  }, [theme]);

  // Keep the overlay pinned to geography rather than pixels.
  const reproject = useCallback((list: PublicSensor[]) => {
    const m = map.current;
    if (!m) return;
    const next: Record<string, { x: number; y: number }> = {};
    for (const s of list) {
      const p = m.project([s.lon, s.lat]);
      next[s.id] = { x: p.x, y: p.y };
    }
    setPoints(next);
  }, []);

  // Frame the sensors that actually exist rather than assuming where they are.
  const framed = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || framed.current || sensors.length === 0) return;
    framed.current = true;
    if (sensors.length === 1) {
      m.easeTo({ center: [sensors[0].lon, sensors[0].lat], zoom: 10.6, duration: 900 });
      return;
    }
    const lons = sensors.map((s) => s.lon);
    const lats = sensors.map((s) => s.lat);
    m.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: { top: 80, bottom: 80, left: 360, right: 380 }, maxZoom: 11, duration: 900 }
    );
  }, [ready, sensors]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const update = () => reproject(sensors);
    update();
    m.on("move", update);
    m.on("zoom", update);
    m.on("resize", update);
    return () => {
      m.off("move", update);
      m.off("zoom", update);
      m.off("resize", update);
    };
  }, [ready, sensors, reproject]);

  // --- live ADS-B through our proxy ---------------------------------------
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/adsb?lat=${VILNIUS[1]}&lon=${VILNIUS[0]}&nm=25`);
        const json = await res.json();
        if (alive && Array.isArray(json.aircraft)) setAircraft(json.aircraft);
      } catch {
        /* the proxy serves stale data on upstream failure */
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /**
   * Poll the public views rather than subscribing to postgres_changes.
   *
   * Realtime on `detections` cannot work for visitors: the table is not in the
   * supabase_realtime publication, and adding it would not help, because
   * Realtime honours RLS and anon has no select policy on that table - by
   * design, since it holds noise rows and undelayed drone matches. The agent
   * uploads every 30 s, so polling matches the real update rate anyway.
   */
  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    const load = async () => {
      const [s, d, st, ty] = await Promise.all([
        supabase.from("public_sensors").select("*"),
        supabase.from("public_detections").select("*").order("started_at", { ascending: false }).limit(60),
        supabase.from("public_sensor_stats").select("*"),
        supabase.from("public_type_stats").select("*").order("passes", { ascending: false }),
      ]);
      if (!alive) return;
      setError(s.error ? s.error.message : null);
      setSensors((s.data as PublicSensor[]) ?? []);
      setStats((st.data as SensorStats[]) ?? []);
      setTypes((ty.data as TypeStats[]) ?? []);

      const rows = (d.data as PublicDetection[]) ?? [];
      setDetections(rows);

      // Flare only for detections that arrived after this page loaded.
      const fresh: Record<string, number> = {};
      for (const row of rows) {
        if (seen.current.has(row.id)) continue;
        seen.current.add(row.id);
        if (!first.current) fresh[row.sensor_id] = Date.now();
      }
      first.current = false;
      if (Object.keys(fresh).length) setFlares((prev) => ({ ...prev, ...fresh }));
    };

    // Sensor liveness is polled faster than history: the agent heartbeats every
    // 10 s, and a "hearing something right now" badge is worthless if it lags.
    const loadLive = async () => {
      const s = await supabase.from("public_sensors").select("*");
      if (!alive || s.error) return;
      setSensors((s.data as PublicSensor[]) ?? []);
    };

    load();
    const slow = setInterval(load, 30_000);
    const fast = setInterval(loadLive, 5_000);
    return () => {
      alive = false;
      clearInterval(slow);
      clearInterval(fast);
    };
  }, []);

  useEffect(() => {
    (map.current?.getSource("aircraft") as GeoJSONSource | undefined)?.setData(
      aircraftFeatures(aircraft)
    );
  }, [aircraft]);

  // --- derived ------------------------------------------------------------
  const total = useMemo(
    () =>
      stats.reduce(
        (acc, s) => ({
          passes: acc.passes + s.passes_24h,
          heard: acc.heard + s.heard_24h,
          detections: acc.detections + s.detections_24h,
          wind: acc.wind + s.wind_24h,
        }),
        { passes: 0, heard: 0, detections: 0, wind: 0 }
      ),
    [stats]
  );

  const baseline = noiseBaseline(stats[0]);
  const heardRate = total.passes ? total.heard / total.passes : null;
  const airborne = aircraft.filter((a) => a.alt_m > 0).length;
  const newest = detections[0] ?? null;
  const online = sensors.filter((s) => s.online).length;
  const hearing = sensors.filter((s) => s.hearing_now).length;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-night-deep">
      {/*
        maplibre-gl.css forces `position: relative` on its container, which
        overrides an `absolute inset-0` and collapses the element to zero
        height - style loads, layers attach, no tile is ever requested. Keep the
        positioning on a wrapper and let the map own a plain full-size box.
      */}
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      {/* Sensors, drawn in the DOM so the arrival animation can be CSS. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {sensors.map((s) => {
          const p = points[s.id];
          if (!p) return null;
          const flare = flares[s.id] ?? 0;
          const bearing = flare && newest?.sensor_id === s.id ? newest.match_bearing : null;
          const phase = sensorPhase(s);
          return (
            <div key={s.id} className="absolute" style={{ left: p.x, top: p.y }}>
              <SensorBeacon
                phase={phase}
                flareKey={flare}
                bearing={bearing}
                label={PHASE_LABEL[phase]}
                detail={
                  phase === "hearing" && s.hearing_for_s >= 1
                    ? `${Math.round(s.hearing_for_s)}s`
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>

      {/* Instrument rail. Flush to the edge rather than a floating card. */}
      <aside className="absolute inset-y-0 left-0 z-10 flex w-[304px] max-w-[86vw] flex-col border-r border-edge bg-night/92 backdrop-blur-xl">
        <header className="border-b border-edge px-5 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-[17px] font-medium tracking-tight text-bone">SkyEar</h1>
              <p className="mt-0.5 text-[12px] text-slate">Vilnius · security cameras as ears</p>
            </div>
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-slate hover:border-sodium hover:text-sodium"
              aria-label={theme === "dark" ? "Switch to light map" : "Switch to dark map"}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>

          <p className="mt-3 flex items-center gap-2 text-[12px]">
            <span
              className="breathe inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: hearing
                  ? "var(--signal)"
                  : online
                    ? "var(--sodium)"
                    : "var(--slate-dim)",
              }}
            />
            <span className="text-slate">
              {hearing > 0
                ? `${hearing} sensor${hearing > 1 ? "s" : ""} hearing something`
                : online > 0
                  ? `${online} sensor${online > 1 ? "s" : ""} listening`
                  : "No sensor listening"}
            </span>
          </p>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto pb-4">
          {/* The measurement the project turns on. */}
          <section className="border-b border-edge px-5 py-4">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[34px] leading-none text-bone">
                {heardRate === null ? "--" : `${Math.round(heardRate * 100)}`}
                <span className="text-[18px] text-slate">%</span>
              </span>
              <span className="text-[12px] text-slate">of passes heard</span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-slate-dim">
              {total.heard}/{total.passes} aircraft · {observedWindow(stats[0])}
            </p>

            {/* A heard rate has to beat the noise it is swimming in. */}
            {baseline !== null && (
              <div className="mt-3">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-haze">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${(heardRate ?? 0) * 100}%`,
                      background: "var(--sodium)",
                    }}
                  />
                  <div
                    className="absolute inset-y-0 w-px"
                    style={{ left: `${baseline * 100}%`, background: "var(--noise)" }}
                  />
                </div>
                <p className="mt-2 text-[11px] leading-snug text-slate-dim">
                  Background noise fills{" "}
                  <span className="font-mono text-noise">{Math.round(baseline * 100)}%</span> of the
                  time, so roughly that share of passes overlaps a sound by chance. Detection only
                  starts above the marked line.
                </p>
              </div>
            )}
          </section>

          {/* Per type: the comparison that shows whether some airframes hide. */}
          {types.length > 0 && (
            <section className="border-b border-edge px-5 py-4">
              <h2 className="text-[12px] text-slate">Heard by aircraft type</h2>
              <ul className="mt-3 space-y-2">
                {types.slice(0, 7).map((t) => {
                  const rate = t.passes ? t.heard / t.passes : 0;
                  return (
                    <li key={t.aircraft_type} className="grid grid-cols-[42px_1fr_auto] items-center gap-2">
                      <span className="font-mono text-[11px] text-bone">{t.aircraft_type}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-haze">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.max(rate * 100, t.heard ? 6 : 0)}%`,
                            background: t.heard ? "var(--signal)" : "transparent",
                          }}
                        />
                      </span>
                      <span className="font-mono text-[10px] text-slate-dim">
                        {t.heard}/{t.passes}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* What the ear is sitting in. */}
          <section className="border-b border-edge px-5 py-4">
            <h2 className="text-[12px] text-slate">Conditions</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
              {[
                ["Noise floor", stats[0]?.avg_floor_db != null ? `${stats[0].avg_floor_db} dB` : "--"],
                ["Events", String(total.detections)],
                ["Wind-tagged", String(total.wind)],
                ["Aircraft up", String(airborne)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] text-slate-dim">{label}</dt>
                  <dd className="font-mono text-[15px] text-bone">{value}</dd>
                </div>
              ))}
            </dl>
            {total.wind > 0 && (
              <p className="mt-3 text-[11px] leading-snug text-slate-dim">
                <span className="text-noise">{total.wind}</span> of {total.detections} events looked
                like wind and were kept off this map.
              </p>
            )}
          </section>

          {sensors.length === 0 && (
            <section className="px-5 py-4">
              <p className="text-[12px] leading-snug text-sodium/90">
                No sensor has paired yet. Generate a code on{" "}
                <a href="/devices" className="underline">
                  your devices page
                </a>{" "}
                and run the agent on the machine with the camera.
              </p>
            </section>
          )}

          {error && (
            <section className="px-5 py-4">
              <p className="text-[12px] text-red-400">{error}</p>
            </section>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-edge px-5 py-3">
          <a href="/devices" className="text-[12px] text-slate hover:text-sodium">
            Your sensors
          </a>
          <a href="/join" className="text-[12px] text-sodium hover:underline">
            Become a sensor
          </a>
        </footer>
      </aside>

      {/* The most recent sound, in enough detail to judge it. */}
      {newest && (
        <section className="absolute bottom-0 right-0 z-10 m-4 w-[332px] max-w-[86vw] rounded-sm border border-edge bg-night/92 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          <div className="flex items-start justify-between border-b border-edge px-4 py-3">
            <div>
              <h2 className="text-[13px] text-bone">
                {newest.match_flight ?? "Sound with no aircraft overhead"}
              </h2>
              <p className="mt-0.5 font-mono text-[11px] text-slate-dim">
                {new Date(newest.started_at).toLocaleTimeString()}
                {newest.match_type ? ` · ${newest.match_type}` : ""}
                {newest.match_slant_m ? ` · ${(newest.match_slant_m / 1000).toFixed(1)} km away` : ""}
              </p>
            </div>
            <OctaveBars octaves={newest.octave_db} />
          </div>

          {newest.match_delay_s !== null && (
            <p className="border-b border-edge px-4 py-2 text-[11px] leading-snug text-slate">
              Heard{" "}
              <span className="font-mono text-sodium">{newest.match_delay_s.toFixed(1)} s</span>{" "}
              after it left the aircraft — the sound is that far behind the sky.
            </p>
          )}

          <ul className="scroll-thin max-h-[38vh] divide-y divide-edge/60 overflow-y-auto">
            {detections.slice(0, 14).map((d, i) => (
              <DetectionRow key={d.id} detection={d} active={i === 0} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

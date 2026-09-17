"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/lib/supabase";
import type { Aircraft, PublicDetection, PublicSensor } from "@/lib/types";

const VILNIUS: [number, number] = [25.34, 54.65];

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


const AIRCRAFT_COLOR = "#38bdf8";
const GROUND_COLOR = "#64748b";
const SENSOR_COLOR = "#22c55e";
const SENSOR_OFFLINE = "#94a3b8";

function aircraftFeatures(list: Aircraft[]) {
  return {
    type: "FeatureCollection" as const,
    features: list.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
      properties: { label: a.flight ?? a.hex, alt: a.alt_m, onGround: a.alt_m <= 0 },
    })),
  };
}

function sensorFeatures(list: PublicSensor[]) {
  return {
    type: "FeatureCollection" as const,
    features: list.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      properties: { online: s.online },
    })),
  };
}

export default function SkyMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [sensors, setSensors] = useState<PublicSensor[]>([]);
  const [detections, setDetections] = useState<PublicDetection[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Latest data and theme, so layers re-added after a style swap are current.
  const latest = useRef({ aircraft, sensors });
  latest.current = { aircraft, sensors };
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  /**
   * Swapping a vector style discards every custom source and layer, so this
   * runs on each `style.load`, not once on `load`.
   */
  const addLayers = useCallback((m: MapLibreMap, forTheme: Theme) => {
    const halo = forTheme === "dark" ? "#0b1220" : "#ffffff";
    const text = forTheme === "dark" ? "#e2e8f0" : "#1f2933";

    if (!m.getSource("aircraft")) {
      m.addSource("aircraft", { type: "geojson", data: aircraftFeatures(latest.current.aircraft) });
    }
    if (!m.getSource("sensors")) {
      m.addSource("sensors", { type: "geojson", data: sensorFeatures(latest.current.sensors) });
    }
    if (!m.getLayer("sensor-halo")) {
      m.addLayer({
        id: "sensor-halo",
        type: "circle",
        source: "sensors",
        paint: {
          "circle-radius": 16,
          "circle-color": ["case", ["get", "online"], SENSOR_COLOR, SENSOR_OFFLINE],
          "circle-opacity": 0.2,
          "circle-blur": 0.4,
        },
      });
    }
    if (!m.getLayer("sensor-dot")) {
      m.addLayer({
        id: "sensor-dot",
        type: "circle",
        source: "sensors",
        paint: {
          "circle-radius": 5,
          "circle-color": ["case", ["get", "online"], SENSOR_COLOR, SENSOR_OFFLINE],
          "circle-stroke-width": 2,
          "circle-stroke-color": halo,
        },
      });
    }
    if (!m.getLayer("aircraft-dot")) {
      m.addLayer({
        id: "aircraft-dot",
        type: "circle",
        source: "aircraft",
        paint: {
          "circle-radius": ["case", ["get", "onGround"], 3, 5],
          "circle-color": ["case", ["get", "onGround"], GROUND_COLOR, AIRCRAFT_COLOR],
          "circle-stroke-width": 1,
          "circle-stroke-color": halo,
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
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
        },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.4 },
      });
    }
  }, []);

  useEffect(() => {
    if (map.current || !container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: STYLES.dark,
      center: VILNIUS,
      zoom: 10,
      // The CARTO styles carry their own OSM + CARTO attribution; adding ours
      // on top rendered it twice.
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // MapLibre swallows style and tile failures unless you listen for them.
    m.on("error", (e) => {
      const msg = (e as unknown as { error?: { message?: string } }).error?.message ?? String(e);
      console.error("[skyear] map error:", msg);
      setError(msg);
    });

    // The map is constructed while the dynamic-import placeholder is still
    // swapping out, so the container can be zero-height for a frame. MapLibre
    // does not re-check on its own: without this the style loads, the layers
    // attach, and not one tile is ever requested - silently.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);

    m.on("style.load", () => {
      addLayers(m, themeRef.current);
      map.current = m;
    });

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, [addLayers]);

  useEffect(() => {
    map.current?.setStyle(STYLES[theme]); // style.load re-adds our layers
  }, [theme]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/adsb?lat=${VILNIUS[1]}&lon=${VILNIUS[0]}&nm=25`);
        const json = await res.json();
        if (alive && Array.isArray(json.aircraft)) setAircraft(json.aircraft);
      } catch {
        /* transient - the proxy serves stale data on upstream failure */
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    (async () => {
      const [s, d] = await Promise.all([
        supabase.from("public_sensors").select("*"),
        supabase.from("public_detections").select("*").order("started_at", { ascending: false }).limit(50),
      ]);
      if (!alive) return;
      if (s.error) setError(s.error.message);
      setSensors((s.data as PublicSensor[]) ?? []);
      setDetections((d.data as PublicDetection[]) ?? []);
    })();

    const channel = supabase
      .channel("detections")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "detections" }, (payload) => {
        const row = payload.new as PublicDetection;
        if (row.class === "noise") return;
        setDetections((prev) => [row, ...prev].slice(0, 50));
      })
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    (map.current?.getSource("aircraft") as GeoJSONSource | undefined)?.setData(aircraftFeatures(aircraft));
  }, [aircraft]);

  useEffect(() => {
    (map.current?.getSource("sensors") as GeoJSONSource | undefined)?.setData(sensorFeatures(sensors));
  }, [sensors]);

  const airborne = aircraft.filter((a) => a.alt_m > 0).length;
  const panel =
    "rounded-xl border border-white/10 bg-neutral-900/80 text-neutral-100 shadow-xl backdrop-blur-md";

  return (
    <div className="relative h-dvh w-full bg-neutral-950">
      <div ref={container} className="h-full w-full" />

      <div className="pointer-events-none absolute left-0 top-0 p-3">
        <div className={`pointer-events-auto w-60 p-3 ${panel}`}>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-sm font-semibold tracking-tight">SkyEar</h1>
              <p className="mt-0.5 text-[11px] text-neutral-400">
                Acoustic aircraft detection · Vilnius
              </p>
            </div>
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-white/10"
              aria-label="Toggle basemap theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            {([["Airborne", airborne], ["Sensors", sensors.length], ["Events", detections.length]] as const).map(
              ([label, value]) => (
                <div key={label}>
                  <dt className="text-neutral-500">{label}</dt>
                  <dd className="font-mono text-base leading-tight text-neutral-100">{value}</dd>
                </div>
              )
            )}
          </dl>

          {sensors.length === 0 && (
            <p className="mt-3 border-t border-white/10 pt-2 text-[11px] leading-snug text-amber-400/90">
              No sensor has paired yet — the agent still writes only to local disk. Aircraft shown
              are live ADS-B.
            </p>
          )}
          {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        </div>
      </div>

      {detections.length > 0 && (
        <div
          className={`pointer-events-auto absolute bottom-0 right-0 m-3 max-h-64 w-72 overflow-y-auto p-3 text-[11px] ${panel}`}
        >
          <h2 className="mb-1.5 font-semibold">Recent detections</h2>
          <ul className="space-y-1">
            {detections.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span className="font-mono text-neutral-400">
                  {new Date(d.started_at).toLocaleTimeString()}
                </span>
                <span className="truncate">{d.match_flight ?? d.class}</span>
                <span className="text-neutral-500">{Math.round(d.duration_s)}s</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import type { GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/lib/supabase";
import type { Aircraft, PublicDetection, PublicSensor } from "@/lib/types";

const VILNIUS: [number, number] = [25.34, 54.65];

/** OSM raster tiles. Attribution is required by the tile usage policy. */
const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

function aircraftFeatures(list: Aircraft[]) {
  return {
    type: "FeatureCollection" as const,
    features: list.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
      properties: {
        label: a.flight ?? a.hex,
        alt: a.alt_m,
        rotation: a.track ?? 0,
        onGround: a.alt_m <= 0,
      },
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
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [sensors, setSensors] = useState<PublicSensor[]>([]);
  const [detections, setDetections] = useState<PublicDetection[]>([]);
  const [error, setError] = useState<string | null>(null);

  // --- map setup -----------------------------------------------------------
  useEffect(() => {
    if (map.current || !container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: STYLE,
      center: VILNIUS,
      zoom: 10,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("aircraft", { type: "geojson", data: aircraftFeatures([]) });
      m.addSource("sensors", { type: "geojson", data: sensorFeatures([]) });

      // Sensors sit under aircraft so a busy sky never hides the network.
      m.addLayer({
        id: "sensor-halo",
        type: "circle",
        source: "sensors",
        paint: {
          "circle-radius": 14,
          "circle-color": ["case", ["get", "online"], "#2f9e6e", "#8a8a8a"],
          "circle-opacity": 0.18,
        },
      });
      m.addLayer({
        id: "sensor-dot",
        type: "circle",
        source: "sensors",
        paint: {
          "circle-radius": 5,
          "circle-color": ["case", ["get", "online"], "#2f9e6e", "#8a8a8a"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      m.addLayer({
        id: "aircraft-dot",
        type: "circle",
        source: "aircraft",
        paint: {
          "circle-radius": ["case", ["get", "onGround"], 3, 5],
          "circle-color": ["case", ["get", "onGround"], "#9aa0a6", "#1f6feb"],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });
      m.addLayer({
        id: "aircraft-label",
        type: "symbol",
        source: "aircraft",
        filter: ["!", ["get", "onGround"]],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
        },
        paint: { "text-color": "#1f2933", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      });
      map.current = m;
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // --- live ADS-B through our proxy ---------------------------------------
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

  // --- sensors + detections, with realtime --------------------------------
  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    (async () => {
      const [s, d] = await Promise.all([
        supabase.from("public_sensors").select("*"),
        supabase
          .from("public_detections")
          .select("*")
          .order("started_at", { ascending: false })
          .limit(50),
      ]);
      if (!alive) return;
      if (s.error) setError(s.error.message);
      setSensors((s.data as PublicSensor[]) ?? []);
      setDetections((d.data as PublicDetection[]) ?? []);
    })();

    const channel = supabase
      .channel("detections")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "detections" },
        (payload) => {
          const row = payload.new as PublicDetection;
          if (row.class === "noise") return;
          setDetections((prev) => [row, ...prev].slice(0, 50));
        }
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const src = map.current?.getSource("aircraft") as GeoJSONSource | undefined;
    src?.setData(aircraftFeatures(aircraft));
  }, [aircraft]);

  useEffect(() => {
    const src = map.current?.getSource("sensors") as GeoJSONSource | undefined;
    src?.setData(sensorFeatures(sensors));
  }, [sensors]);

  const airborne = aircraft.filter((a) => a.alt_m > 0).length;

  return (
    <div className="relative h-dvh w-full">
      <div ref={container} className="h-full w-full" />

      <div className="pointer-events-none absolute left-0 top-0 p-3">
        <div className="pointer-events-auto rounded-lg bg-white/92 p-3 shadow-lg backdrop-blur dark:bg-neutral-900/92">
          <h1 className="text-sm font-semibold tracking-tight">SkyEar</h1>
          <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
            Acoustic aircraft detection · Vilnius
          </p>
          <dl className="mt-2 grid grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-neutral-500">Airborne</dt>
              <dd className="font-mono text-sm">{airborne}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Sensors</dt>
              <dd className="font-mono text-sm">{sensors.length}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Detections</dt>
              <dd className="font-mono text-sm">{detections.length}</dd>
            </div>
          </dl>
          {sensors.length === 0 && (
            <p className="mt-2 max-w-56 text-xs text-amber-700 dark:text-amber-500">
              No paired sensors yet. Aircraft shown are live ADS-B.
            </p>
          )}
          {error && <p className="mt-2 max-w-56 text-xs text-red-600">{error}</p>}
        </div>
      </div>

      {detections.length > 0 && (
        <div className="pointer-events-auto absolute bottom-0 right-0 m-3 max-h-64 w-72 overflow-y-auto rounded-lg bg-white/92 p-3 text-xs shadow-lg backdrop-blur dark:bg-neutral-900/92">
          <h2 className="mb-1 font-semibold">Recent detections</h2>
          <ul className="space-y-1">
            {detections.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span className="font-mono">{new Date(d.started_at).toLocaleTimeString()}</span>
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

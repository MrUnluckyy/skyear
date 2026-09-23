"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  PHASE_LABEL,
  PHASE_RANK,
  verdict,
  conditionVerdict,
  fleetBaseline,
  fleetWindow,
  isNotable,
  poolFamilies,
  sensorNames,
  sensorPhase,
  unaccountedBySensor,
  type Aircraft,
  type PublicDetection,
  type PublicSensor,
  type SensorConditions,
  type SensorStats,
  type SpectrumBaseline,
  type TypeStats,
} from "@/lib/types";
import { DetectionRow, OctaveBars, SensorBeacon } from "./SensorBeacon";
import SensorPanel from "./SensorPanel";
import { PeriodicityNote, RotorSignature, SoundProfile, TiltScale } from "./SoundProfile";

/**
 * v6 loads its worker as a separate ES module that does not resolve under
 * Turbopack, and vector tiles are fetched *inside* that worker - so without
 * this the style loads, layers attach, and no tile is ever requested, silently.
 * v6 is required: every earlier release carries a critical XSS advisory
 * (GHSA-jrc7-96c5-q579) in DOM.sanitize, which style-supplied attribution HTML
 * passes through.
 */
setWorkerUrl("/maplibre-gl-worker.mjs");

/**
 * The map opens on the whole country rather than on a sensor. Zoomed onto one
 * contributor's neighbourhood it read as a Vilnius project, and the aircraft
 * feed covers all of Lithuania (app/api/adsb/route.ts). Widen this alongside
 * the feed's regions when sensors arrive in a neighbouring country.
 */
const LITHUANIA: [[number, number], [number, number]] = [
  [20.93, 53.9],
  [26.84, 56.45],
];

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

const LATEST_OPEN = "skyear:latest-open";

const FROST = "#c9e2f0";
const GROUND = "#55697a";

/** What /api/map and /api/map/live return; both are cached at the edge. */
type MapPayload = {
  sensors?: PublicSensor[];
  detections?: PublicDetection[];
  stats?: SensorStats[];
  types?: TypeStats[];
  spectrum?: SpectrumBaseline[];
  conditions?: SensorConditions[];
  error?: string | null;
};

/*
 * Aircraft are the control group, not the subject.
 *
 * A flight tracker makes them the hero. Here they are the texture a sound is
 * read against, so they are drawn quiet and oriented, and only light up when a
 * sensor actually heard one. ADS-B gives the heading for nothing, and an
 * oriented silhouette reads as traffic at a size where a dot still read as a
 * marker asking to be clicked.
 *
 * Top view, nose up, in a 24x24 box: fuselage, swept wings, tailplane.
 */
const PLANE =
  "M12 1.2 L13.1 4.6 L13.1 9.2 L22 14.4 L22 16.4 L13.1 13.8 L13.1 19.2 " +
  "L15.6 21.3 L15.6 22.6 L12 21.6 L8.4 22.6 L8.4 21.3 L10.9 19.2 L10.9 13.8 " +
  "L2 16.4 L2 14.4 L10.9 9.2 L10.9 4.6 Z";

function planeImage(colour: string, ratio = 2) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 24 * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = colour;
  ctx.fill(new Path2D(PLANE));
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/*
 * Rough size from the ICAO type code, and rough is the honest word: it is a
 * prefix test over the types that actually fly here, not a fleet database. A
 * wrong guess costs a few pixels, so the failure is invisible rather than
 * misleading - which is the only reason a heuristic belongs on the map at all.
 */
const HEAVY = /^(A3[3458]|A38|B7[4678]|B75|IL7|AN1|C17|MD11)/;
const LIGHT = /^(C1[0-9]|C2[0-9]|P28|PA[0-9]|DA[24]|SR2|TBM|BE[0-9]|AT[0-9]|DH8|L410|EV97|VL3)/;
const ROTOR = /^(EC[0-9]|H1[0-9]|R22|R44|R66|S76|A13|B06|AS3|MI[0-9]|UH[0-9])/;

function aircraftScale(type: string | null) {
  if (!type) return 0.62;
  const t = type.toUpperCase();
  if (ROTOR.test(t)) return 0.5;
  if (HEAVY.test(t)) return 0.9;
  if (LIGHT.test(t)) return 0.5;
  return 0.68; // the narrowbodies that make up most of the traffic here
}

function aircraftFeatures(list: Aircraft[], heard: Set<string>) {
  return {
    type: "FeatureCollection" as const,
    features: list.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
      properties: {
        // Callsign, then registration, then the ICAO address. Most light
        // aircraft carry no callsign at all, and "LY-LMM" is recognisable in a
        // way that "502dae" is not.
        label: a.flight ?? a.reg ?? a.hex,
        alt: a.alt_m,
        onGround: a.alt_m <= 0,
        // Null track is common on the ground and on older transponders. Nose
        // north beats refusing to draw the aircraft.
        track: a.track ?? 0,
        scale: aircraftScale(a.type),
        heard: a.flight ? heard.has(a.flight.trim().toUpperCase()) : false,
      },
    })),
  };
}

export default function SkyMap() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  /*
   * The element the beacons are mounted into: MapLibre's canvas container,
   * not a sibling div.
   *
   * As a sibling, a wheel or touch event landing on a beacon bubbled up the
   * overlay and out to the page - it never crossed the element MapLibre
   * listens on, so scrolling over a sensor silently did nothing and pinch
   * died with it. Inside the canvas container the events reach the map the
   * same way they do for MapLibre's own markers.
   */
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");

  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [sensors, setSensors] = useState<PublicSensor[]>([]);
  const [detections, setDetections] = useState<PublicDetection[]>([]);
  const [stats, setStats] = useState<SensorStats[]>([]);
  const [types, setTypes] = useState<TypeStats[]>([]);
  const [spectrum, setSpectrum] = useState<SpectrumBaseline[]>([]);
  const [conditions, setConditions] = useState<SensorConditions[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // On a phone the rail is a sheet that starts closed, so the map - the thing
  // people came for - is not buried under two panels of statistics.
  const [railOpen, setRailOpen] = useState(false);
  // Ticks so "heard 4 min ago" ages without a reload. Kept out of render,
  // which cannot read the clock.
  const [now, setNow] = useState(0);
  // The latest-sound card covers a corner of the map, and someone reading the
  // map wants it out of the way. Remembered, because re-collapsing it on every
  // visit is the annoying kind of tidy. Client-only component, so reading
  // storage during the first render cannot mismatch a server render.
  const [latestOpen, setLatestOpen] = useState(() => {
    try {
      return window.localStorage.getItem(LATEST_OPEN) !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(LATEST_OPEN, latestOpen ? "1" : "0");
    } catch {
      /* private window, or site data blocked: the preference just will not stick */
    }
  }, [latestOpen]);

  // Screen positions for the DOM overlay, reprojected as the map moves.
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});
  // Bumped when a sensor reports something new, which drives the arrival flare.
  const [flares, setFlares] = useState<Record<string, number>>({});
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);

  /*
   * Which aircraft a sensor has actually heard recently, by callsign.
   *
   * public_detections carries match_flight but not the ICAO address, so the
   * callsign is the join. It is not unique for all time - the same flight
   * number flies daily - but over this window it identifies the aircraft in
   * the sky well enough to light one up.
   */
  const heardFlights = useMemo(() => {
    const since = Date.now() - 15 * 60_000;
    const out = new Set<string>();
    for (const d of detections) {
      if (d.match_flight && Date.parse(d.started_at) >= since) {
        out.add(d.match_flight.trim().toUpperCase());
      }
    }
    return out;
  }, [detections]);

  const latest = useRef({ aircraft, heardFlights });
  latest.current = { aircraft, heardFlights };
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  const addLayers = useCallback((m: MapLibreMap, forTheme: Theme) => {
    const halo = forTheme === "dark" ? "#080d12" : "#ffffff";
    const text = forTheme === "dark" ? "#c9e2f0" : "#1f2933";

    // Traffic nobody heard sits close to the basemap. Frost is reserved for the
    // aircraft a sensor actually picked up, which is the only one worth a look.
    const quiet = forTheme === "dark" ? "#5b7183" : "#9aadba";
    for (const [id, colour] of [["plane-quiet", quiet], ["plane-heard", FROST]] as const) {
      if (!m.hasImage(id)) {
        const img = planeImage(colour);
        if (img) m.addImage(id, img, { pixelRatio: 2 });
      }
    }

    if (!m.getSource("aircraft")) {
      m.addSource("aircraft", {
        type: "geojson",
        data: aircraftFeatures(latest.current.aircraft, latest.current.heardFlights),
      });
    }
    // Parked transponders on an apron are not traffic and should not read as a
    // formation of aircraft sitting on the airport. They stay dots, dimmer.
    if (!m.getLayer("aircraft-ground")) {
      m.addLayer({
        id: "aircraft-ground",
        type: "circle",
        source: "aircraft",
        filter: ["get", "onGround"],
        paint: {
          "circle-radius": 2,
          "circle-color": GROUND,
          "circle-opacity": 0.35,
        },
      });
    }
    if (!m.getLayer("aircraft-plane")) {
      m.addLayer({
        id: "aircraft-plane",
        type: "symbol",
        source: "aircraft",
        filter: ["!", ["get", "onGround"]],
        layout: {
          "icon-image": ["case", ["get", "heard"], "plane-heard", "plane-quiet"],
          "icon-rotate": ["get", "track"],
          "icon-rotation-alignment": "map",
          // Small at country zoom where the whole fleet is on screen, bigger
          // once you are looking at one sensor's sky. `zoom` has to sit at the
          // top of the interpolate - it cannot be a factor inside a product -
          // so the per-aircraft scaling goes in the stops instead.
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            ["*", ["get", "scale"], ["case", ["get", "heard"], 1.2, 1], 0.62],
            10,
            ["*", ["get", "scale"], ["case", ["get", "heard"], 1.2, 1], 1],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ["case", ["get", "heard"], 1, 0.5],
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
        paint: {
          "text-color": ["case", ["get", "heard"], text, quiet],
          "text-halo-color": halo,
          "text-halo-width": 1.6,
          // Labelling every aircraft at every zoom was most of what made the
          // sky louder than the ground. A callsign is only worth the ink once
          // a sensor heard that aircraft, or once you have zoomed in far
          // enough to be asking about one of them in particular.
          "text-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8.5,
            ["case", ["get", "heard"], 1, 0],
            10,
            ["case", ["get", "heard"], 1, 0.75],
          ],
        },
      });
    }
  }, []);

  // --- map ----------------------------------------------------------------
  useEffect(() => {
    if (map.current || !container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: STYLES.dark,
      // Only until the first fit below: the container may not have a size yet.
      center: [23.89, 55.17],
      zoom: 6,
      // Added by hand below, on the other side: the default bottom-right
      // corner is where the latest-sound card sits, and attribution that is
      // covered is not attribution.
      attributionControl: false,
    });
    // Zoom buttons only where there is room for them. Touch devices pinch, and
    // on a phone the controls would sit under the rail anyway.
    if (window.innerWidth >= 768) {
      m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    }
    m.addControl(
      new AttributionControl({
        compact: true,
        customAttribution:
          'Aircraft <a href="https://adsb.lol" target="_blank" rel="noreferrer">adsb.lol</a>',
      }),
      "bottom-left"
    );

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
      setOverlayHost(m.getCanvasContainer());
      setReady(true);
    });

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      setOverlayHost(null);
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

  // Fit the country once, when the map first has a real size to fit it into.
  const framed = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || framed.current) return;
    framed.current = true;
    // Panels sit beside the map on a desktop and over it on a phone, so the
    // room to leave differs entirely. On a phone the newest-detection sheet
    // takes up to 62dvh from the bottom, and a country fitted behind it is a
    // map of Latvia.
    const wide = window.innerWidth >= 768;
    m.fitBounds(LITHUANIA, {
      padding: wide
        ? { top: 80, bottom: 80, left: 360, right: 380 }
        : { top: 120, bottom: Math.round(window.innerHeight * 0.62) + 16, left: 24, right: 24 },
      animate: false,
    });
  }, [ready]);

  /*
   * How much of the arriving-wavefront halo to draw, 0 to 1.
   *
   * The rings are a fixed 92px across, which is a constant number of pixels
   * and therefore a growing number of kilometres as you zoom out. At the
   * opening zoom of 6, around latitude 55, a pixel is roughly 1.4 km - so the
   * halo claimed a listening radius near 46 km. The measured range is a few
   * kilometres. Decoration was making a coverage claim, in the flattering
   * direction, on a map whose whole argument is that it does not flatter.
   *
   * 46px is honest at zoom 10 and closer (about 4 km and falling). Below that
   * it fades out, leaving the dot, which is a position rather than an area.
   * Written to a CSS variable rather than React state because this runs on
   * every frame of a pinch.
   */
  const paintHalo = useCallback(() => {
    const m = map.current;
    if (!m || !overlay.current) return;
    const scale = Math.max(0, Math.min(1, (m.getZoom() - 7) / 3));
    overlay.current.style.setProperty("--beacon-halo", String(scale));
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const update = () => {
      reproject(sensors);
      paintHalo();
    };
    update();
    m.on("move", update);
    m.on("zoom", update);
    m.on("resize", update);
    return () => {
      m.off("move", update);
      m.off("zoom", update);
      m.off("resize", update);
    };
  }, [ready, sensors, reproject, paintHalo]);

  // --- live ADS-B through our proxy ---------------------------------------
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/adsb");
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
    let alive = true;

    const load = async () => {
      let payload: MapPayload;
      try {
        payload = (await (await fetch("/api/map")).json()) as MapPayload;
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!alive) return;
      setError(payload.error ?? null);
      setSensors(payload.sensors ?? []);
      setStats(payload.stats ?? []);
      setTypes(payload.types ?? []);
      setSpectrum(payload.spectrum ?? []);
      setConditions(payload.conditions ?? []);

      const rows = payload.detections ?? [];
      setDetections(rows);

      // Flare only for detections that arrived after this page loaded.
      const fresh: Record<string, number> = {};
      for (const row of rows) {
        if (seen.current.has(row.id)) continue;
        seen.current.add(row.id);
        // Flare for arrivals the project can stand behind. Every passing van
        // used to flash the map, which taught people the flash meant nothing.
        if (!first.current && isNotable(row)) fresh[row.sensor_id] = Date.now();
      }
      first.current = false;
      if (Object.keys(fresh).length) setFlares((prev) => ({ ...prev, ...fresh }));
    };

    // Sensor liveness is polled faster than history: the agent heartbeats every
    // 10 s, and a "hearing something right now" badge is worthless if it lags.
    const loadLive = async () => {
      try {
        const live = (await (await fetch("/api/map/live")).json()) as MapPayload;
        if (!alive || live.error || !live.sensors) return;
        setSensors(live.sensors);
      } catch {
        /* a dropped poll is not worth surfacing; the next one is 5 s away */
      }
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
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    (map.current?.getSource("aircraft") as GeoJSONSource | undefined)?.setData(
      aircraftFeatures(aircraft, heardFlights)
    );
  }, [aircraft, heardFlights]);

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

  const baseline = fleetBaseline(stats);
  const excluded = stats.reduce((n, s) => n + (s.excluded_passes_24h || 0), 0);
  // public_type_stats is per sensor, so an airframe seen by two sensors
  // appeared twice in this list with different figures - which reads as a bug
  // and hides the pooled sample size that actually matters.
  const families = useMemo(() => poolFamilies(types), [types]);
  const [allTypes, setAllTypes] = useState(false);
  const typeTotals = useMemo(
    () =>
      families.reduce(
        (a, f) => ({ heard: a.heard + f.heard, passes: a.passes + f.passes }),
        { heard: 0, passes: 0 }
      ),
    [families]
  );

  /**
   * The last thing worth announcing, and when.
   *
   * A sensor hears something roughly all the time - a thousand events a day at
   * a roadside - so "hearing something" is not news. A match the geometry
   * supports is.
   */
  const lastNotable = useMemo(() => detections.find(isNotable) ?? null, [detections]);
  const notableAgeMin =
    lastNotable && now > 0
      ? Math.floor((now - new Date(lastNotable.started_at).getTime()) / 60_000)
      : null;
  const heardRate = total.passes ? total.heard / total.passes : null;
  const airborne = aircraft.filter((a) => a.alt_m > 0).length;
  const newest = detections[0] ?? null;
  /*
   * Group sensors that overlap on screen.
   *
   * Positions are published on a ~1 km grid, so sensors at one address resolve
   * to the same point and no amount of zooming separates them. Scattering them
   * by a fixed pixel offset made them clickable but implied they were in
   * different places, which at low zoom reads as a wider network than exists.
   *
   * One marker per visual group, carrying a count, is both truer and clearer:
   * zoom out and nearby sensors merge, zoom in and genuinely separate ones
   * split apart on their own.
   */
  const clusters = useMemo(() => {
    const MERGE_PX = 34;
    const out: { x: number; y: number; members: PublicSensor[] }[] = [];
    for (const sensor of sensors) {
      const p = points[sensor.id];
      if (!p) continue;
      const near = out.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < MERGE_PX);
      if (near) {
        near.members.push(sensor);
        // Sit the marker at the centre of what it represents.
        near.x = (near.x * (near.members.length - 1) + p.x) / near.members.length;
        near.y = (near.y * (near.members.length - 1) + p.y) / near.members.length;
      } else {
        out.push({ x: p.x, y: p.y, members: [sensor] });
      }
    }
    return out;
  }, [sensors, points]);

  /*
   * Names, fixed to the sensor rather than to its position in a result set.
   * Someone who opened "Sensor 1" expects to still be looking at it a poll
   * later; an owner who named it expects to see that name here.
   */
  const names = useMemo(() => sensorNames(sensors), [sensors]);

  /*
   * Conditions now, taken as the busiest sensor over the last hour. The worst
   * one governs: if any ear is swamped, a detection from it is coincidence, and
   * a headline that averaged that away would be hiding the caveat rather than
   * showing it.
   */
  const liveDuty = useMemo(() => {
    const online = new Set(sensors.filter((s) => s.online).map((s) => s.id));
    const hour = conditions.filter((c) => c.window_min === 60 && online.has(c.sensor_id));
    if (!hour.length) return null;
    return Math.max(...hour.map((c) => c.duty));
  }, [conditions, sensors]);
  const recentUnaccounted = useMemo(() => unaccountedBySensor(detections), [detections]);

  const online = sensors.filter((s) => s.online).length;
  const selectedSensor = sensors.find((s) => s.id === selected) ?? null;
  const hearing = sensors.filter((s) => s.hearing_now).length;
  // Sound nothing accounts for. For drone work this is the number that matters:
  // a drone broadcasts nothing, so an unmatched sound is the whole signal.
  const unexplainedCount = detections.filter((d) => verdict(d) === "unexplained").length;

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

      {/*
        Sensors, drawn in the DOM so the arrival animation can be CSS, and
        portalled into the map's own canvas container so they do not swallow
        the gestures meant for the map.
      */}
      {overlayHost &&
        createPortal(
          <div
            ref={overlay}
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={{ ["--beacon-halo" as string]: 1 }}
          >
            {clusters.map((cluster) => {
          // The group shows its liveliest member: one sensor hearing something
          // matters more than three sitting quiet.
          const lead = cluster.members.reduce((best, s) =>
            PHASE_RANK[sensorPhase(s)] > PHASE_RANK[sensorPhase(best)] ? s : best
          );
          const phase = sensorPhase(lead);
          const flare = flares[lead.id] ?? 0;
          const bearing = flare && newest?.sensor_id === lead.id ? newest.match_bearing : null;
          const many = cluster.members.length > 1;
          const key = cluster.members.map((m) => m.id).join("+");
          const unexplained = cluster.members.reduce(
            (n, m) => n + (recentUnaccounted[m.id] ?? 0),
            0
          );

          return (
            <div key={key} className="absolute" style={{ left: cluster.x, top: cluster.y }}>
              <button
                onClick={() =>
                  setSelected(
                    cluster.members.some((m) => m.id === selected) ? null : lead.id
                  )
                }
                className="pointer-events-auto absolute -left-[18px] -top-[18px] h-9 w-9 cursor-pointer rounded-full"
                aria-label={
                  many
                    ? `Show the ${cluster.members.length} sensors here`
                    : `Show what ${names[lead.id] ?? "this sensor"} has heard`
                }
              />
              <SensorBeacon
                phase={phase}
                flareKey={flare}
                bearing={bearing}
                name={many ? `${cluster.members.length} sensors` : names[lead.id]}
                label={PHASE_LABEL[phase]}
                unaccounted={unexplained}
                detail={
                  phase === "hearing" && lead.hearing_for_s >= 1
                    ? `${Math.round(lead.hearing_for_s)}s`
                    : undefined
                }
                count={many ? cluster.members.length : 0}
              />
            </div>
          );
            })}
          </div>,
          overlayHost
        )}

      {/* Instrument rail. Flush to the edge rather than a floating card. */}
      <aside className="absolute inset-x-0 top-0 z-10 flex max-h-[80dvh] flex-col border-b border-edge bg-night/92 backdrop-blur-xl md:inset-x-auto md:inset-y-0 md:left-0 md:max-h-none md:w-[304px] md:border-b-0 md:border-r">
        <header className="px-5 py-4 md:border-b md:border-edge">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[17px] font-medium tracking-tight text-bone">SkyEar</h1>
              <p className="mt-0.5 truncate text-[12px] text-slate">
                Cameras as ears · Lithuania
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* The headline figure stays visible when the sheet is closed,
                  so the bar is worth its space on a small screen. */}
              <span className="font-mono text-[15px] text-bone md:hidden">
                {heardRate === null ? "--" : `${Math.round(heardRate * 100)}%`}
              </span>
              <button
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-slate hover:border-sodium hover:text-sodium"
                aria-label={theme === "dark" ? "Switch to light map" : "Switch to dark map"}
              >
                {theme === "dark" ? "☀" : "☾"}
              </button>
              <button
                onClick={() => setRailOpen((v) => !v)}
                className="rounded border border-edge px-2 py-0.5 text-[11px] text-slate hover:border-sodium hover:text-sodium md:hidden"
                aria-expanded={railOpen}
              >
                {railOpen ? "Hide" : "Details"}
              </button>
            </div>
          </div>

          {/*
            What this line used to say was "3 sensors hearing something", all
            day, because a microphone outdoors always is. It now leads with the
            last match the geometry supports and keeps live sound as an aside,
            which is the order of interest.
          */}
          <p className="mt-3 flex items-baseline gap-2 text-[12px]">
            <span
              className="breathe inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full"
              style={{
                background:
                  notableAgeMin !== null && notableAgeMin < 15
                    ? "var(--signal)"
                    : online
                      ? "var(--sodium)"
                      : "var(--slate-dim)",
              }}
            />
            <span className="min-w-0 truncate text-slate">
              {online === 0 ? (
                "No sensor listening"
              ) : lastNotable && notableAgeMin !== null && notableAgeMin < 120 ? (
                <>
                  {lastNotable.match_flight ?? "Drone-like sound"} heard{" "}
                  {notableAgeMin < 1 ? "just now" : `${notableAgeMin} min ago`}
                </>
              ) : (
                `${online} sensor${online > 1 ? "s" : ""} listening`
              )}
              {hearing > 0 && (
                <span className="text-slate-dim"> · sound now</span>
              )}
            </span>
          </p>
        </header>

        <div
          className={`scroll-thin flex-1 overflow-y-auto pb-4 ${railOpen ? "" : "hidden md:block"}`}
        >
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
              {total.heard}/{total.passes} aircraft · {fleetWindow(stats)}
            </p>
            {excluded > 0 && (
              <p className="mt-1.5 text-[11px] leading-snug text-slate-dim">
                <span className="font-mono text-noise">{excluded}</span> further passes are held out:
                the agent&rsquo;s clock had drifted, so matching was inoperative and a
                &ldquo;not heard&rdquo; from that window is not evidence of anything.
              </p>
            )}

            {/*
              Conditions right now. Placed directly under the headline because
              it decides what the headline is worth: at 60% duty most passes
              coincide with a sound whatever the sensors do.
            */}
            {liveDuty !== null && (() => {
              const v = conditionVerdict(liveDuty);
              const tone =
                v.tone === "bad" ? "var(--bad)" : v.tone === "fair" ? "var(--sodium)" : "var(--signal)";
              return (
                <div className="mt-3 border-l-2 pl-3" style={{ borderColor: tone }}>
                  <p className="text-[12px]">
                    <span style={{ color: tone }}>Right now: {v.label}</span>
                    <span className="ml-1.5 font-mono text-[11px] text-slate-dim">
                      sound present {Math.round(liveDuty * 100)}% of the last hour
                    </span>
                  </p>
                  <p className="mt-1 text-[11px] leading-snug text-slate-dim">{v.note}</p>
                </div>
              );
            })()}

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

          {/*
            Per family: the comparison that shows whether some airframes hide.

            Grouped rather than per ICAO type. A320, A20N and A21N are one
            aeroplane to everyone but a spotter, and listing them separately
            filled the rail with rows that read as duplicates while burying the
            question worth asking - do propellers and light aircraft carry as
            far as jets. Background information, so it is sized like it.
          */}
          {types.length > 0 && (
            <section className="border-b border-edge px-5 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[11px] text-slate-dim">
                  By aircraft type
                  {typeTotals.passes > 0 && (
                    <span className="ml-1.5 font-mono">
                      {Math.round((typeTotals.heard / typeTotals.passes) * 100)}% of{" "}
                      {typeTotals.passes}
                    </span>
                  )}
                </h2>
                {families.length > 4 && (
                  <button
                    onClick={() => setAllTypes((v) => !v)}
                    className="text-[11px] text-slate-dim hover:text-sodium"
                  >
                    {allTypes ? "less" : "all"}
                  </button>
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {(allTypes ? families : families.slice(0, 4)).map((t) => {
                  const rate = t.passes ? t.heard / t.passes : 0;
                  return (
                    <li key={t.aircraft_type}>
                      <div className="grid grid-cols-[104px_1fr_auto] items-center gap-2">
                        <span className="truncate text-[11px] text-slate">{t.aircraft_type}</span>
                        <span className="h-1 overflow-hidden rounded-full bg-haze">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${Math.max(rate * 100, t.heard ? 4 : 0)}%`,
                              background: t.heard ? "var(--signal)" : "transparent",
                              opacity: 0.75,
                            }}
                          />
                        </span>
                        <span className="font-mono text-[10px] text-slate-dim">
                          {t.heard}/{t.passes}
                        </span>
                      </div>
                      {allTypes && t.members.length > 1 && (
                        <p className="mt-0.5 pl-1 font-mono text-[10px] text-slate-dim/80">
                          {t.members.join(" ")}
                        </p>
                      )}
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
                ["Unexplained", String(unexplainedCount)],
                ["Sounds today", String(total.detections)],
                ["Wind-tagged", String(total.wind)],
                ["Aircraft tracked", String(airborne)],
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

        <footer
          className={`flex items-center justify-between border-t border-edge px-5 py-3 ${
            railOpen ? "" : "hidden md:flex"
          }`}
        >
          <a href="/reading" className="text-[12px] text-slate hover:text-sodium">
            How to read this
          </a>
          <a href="/devices" className="text-[12px] text-slate hover:text-sodium">
            Your sensors
          </a>
          <a href="/join" className="text-[12px] text-sodium hover:underline">
            Become a sensor
          </a>
        </footer>
        <div
          className={`px-5 pb-3 ${railOpen ? "" : "hidden md:block"}`}
        >
          <a href="/privacy" className="text-[11px] text-slate-dim hover:text-sodium">
            Privacy
          </a>
        </div>
      </aside>

      {selectedSensor && (
        <SensorPanel
          sensor={selectedSensor}
          names={names}
          spectrum={spectrum}
          conditions={conditions}
          stats={stats.find((x) => x.sensor_id === selectedSensor.id)}
          types={types}
          detections={detections}
          siblings={
            clusters.find((c) => c.members.some((m) => m.id === selectedSensor.id))?.members ?? []
          }
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Collapsed: a bar naming what was last heard, and nothing else. */}
      {!selectedSensor && newest && !latestOpen && (
        <button
          onClick={() => setLatestOpen(true)}
          aria-label="Show the latest sound"
          aria-expanded={false}
          className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-edge bg-night/92 px-4 py-2.5 text-left backdrop-blur-xl md:inset-x-auto md:bottom-0 md:right-0 md:m-4 md:max-w-[332px] md:rounded-sm md:border md:border-edge md:px-3 md:py-2 md:shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="shrink-0 text-[11px] text-slate-dim">
              ⌃
            </span>
            <span
              className={`min-w-0 truncate text-[12px] ${newest.match_flight ? "text-bone" : "text-sodium"}`}
            >
              {newest.match_flight ?? "Sound with no aircraft overhead"}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[11px] text-slate-dim">
            {new Date(newest.started_at).toLocaleTimeString()}
          </span>
        </button>
      )}

      {/* The most recent sound, in enough detail to judge it. */}
      {!selectedSensor && newest && latestOpen && (
        <section className="absolute inset-x-0 bottom-0 z-10 flex max-h-[62dvh] flex-col overflow-hidden border-t border-edge bg-night/92 backdrop-blur-xl md:inset-x-auto md:bottom-0 md:right-0 md:m-4 md:max-h-[74dvh] md:w-[332px] md:rounded-sm md:border md:shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
          <div className="flex shrink-0 items-start justify-between border-b border-edge px-4 py-3">
            <div className="min-w-0">
              <h2
                className={`text-[13px] ${newest.match_flight ? "text-bone" : "text-sodium"}`}
              >
                {newest.match_flight ?? "Sound with no aircraft overhead"}
              </h2>
              <p className="mt-0.5 font-mono text-[11px] text-slate-dim">
                {names[newest.sensor_id] ?? "a sensor"} ·{" "}
                {new Date(newest.started_at).toLocaleTimeString()}
                {newest.match_type ? ` · ${newest.match_type}` : ""}
                {newest.match_slant_m ? ` · ${(newest.match_slant_m / 1000).toFixed(1)} km away` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-start gap-2">
              <OctaveBars octaves={newest.octave_db} />
              <button
                onClick={() => setLatestOpen(false)}
                className="rounded border border-edge px-1.5 py-0.5 text-[11px] leading-none text-slate hover:border-sodium hover:text-sodium"
                aria-label="Hide the latest sound"
                aria-expanded
              >
                –
              </button>
            </div>
          </div>

          <div className="scroll-thin flex-1 overflow-y-auto">
          {newest.match_delay_s !== null && (
            <p className="border-b border-edge px-4 py-2 text-[11px] leading-snug text-slate">
              Heard{" "}
              <span className="font-mono text-sodium">{newest.match_delay_s.toFixed(1)} s</span>{" "}
              after it left the aircraft — the sound is that far behind the sky.
            </p>
          )}

          {/* What it was, as far as anything can say. */}
          {newest.octave_db && (
            <div className="space-y-3 border-b border-edge px-4 py-3">
              <SoundProfile detection={newest} />
              <TiltScale detection={newest} baseline={spectrum} />
              <RotorSignature detection={newest} />
              <PeriodicityNote detection={newest} />
            </div>
          )}

          <ul className="divide-y divide-edge/60">
            {detections.slice(0, 14).map((d, i) => (
              <DetectionRow key={d.id} detection={d} active={i === 0} />
            ))}
          </ul>
          </div>
        </section>
      )}
    </div>
  );
}

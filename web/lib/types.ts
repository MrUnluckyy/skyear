/** Rows from `public_sensors` - coarsened to a ~1 km grid by the view. */
export type PublicSensor = {
  id: string;
  status: string;
  /** Owner-chosen and public. Null until someone names it. */
  label: string | null;
  lat: number;
  lon: number;
  /** Reported within the last 45 s. The agent heartbeats every 10 s. */
  online: boolean;
  /** A sound is crossing the threshold at this instant. */
  hearing_now: boolean;
  /** Something has started rising but has not lasted long enough to count. */
  rising: boolean;
  hearing_for_s: number;
  /** How far above this sensor's own noise floor, in dB. */
  excess_db: number | null;
  /** False until the rolling noise floor has settled. */
  warm: boolean;
  /**
   * Whether sound is reaching the detector.
   *
   * Null when the agent does not report it - older agents predate the field,
   * and treating that as false accused healthy sensors of being broken.
   */
  audio: boolean | null;
  reported_at: string | null;
};

export type SensorPhase = "offline" | "warming" | "listening" | "rising" | "hearing";

export function sensorPhase(s: PublicSensor): SensorPhase {
  if (!s.online) return "offline";
  if (s.hearing_now) return "hearing";
  if (s.rising) return "rising";
  if (!s.warm) return "warming";
  return "listening";
}

/** Which state a group of sensors should show: the liveliest one. */
export const PHASE_RANK: Record<SensorPhase, number> = {
  offline: 0,
  warming: 1,
  listening: 2,
  rising: 3,
  hearing: 4,
};

export const PHASE_LABEL: Record<SensorPhase, string> = {
  offline: "offline",
  warming: "warming up",
  listening: "listening",
  rising: "something starting",
  hearing: "hearing something",
};

/**
 * Rows from `public_detections`.
 *
 * Drone rows arrive delayed and stripped: match fields, bearing and acoustics
 * are all null, so the shape is the same but tells you far less.
 */
export type PublicDetection = {
  id: string;
  sensor_id: string;
  class: "unknown" | "aircraft" | "drone";
  started_at: string;
  duration_s: number;
  snr_db: number | null;
  dominant_hz: number | null;
  floor_db: number | null;
  low_tilt_db: number | null;
  cpp_db: number | null;
  f0_hz: number | null;
  /** The sound repeats, the way an engine does and wind does not. */
  harmonic: boolean;
  octave_db: Record<string, number> | null;
  match_flight: string | null;
  match_type: string | null;
  match_slant_m: number | null;
  match_alt_m: number | null;
  match_bearing: number | null;
  match_delay_s: number | null;
};

export type SensorStats = {
  sensor_id: string;
  passes_24h: number;
  heard_24h: number;
  detections_24h: number;
  wind_24h: number;
  event_seconds_24h: number;
  /** Seconds of listening the other figures are drawn from. */
  observed_seconds: number;
  last_detection_at: string | null;
  avg_floor_db: number | null;
};

export type TypeStats = {
  sensor_id: string;
  aircraft_type: string;
  passes: number;
  heard: number;
  avg_slant_m: number;
};

/** Live ADS-B aircraft, served by our own proxy - never fetched per browser. */
export type Aircraft = {
  hex: string;
  flight: string | null;
  type: string | null;
  lat: number;
  lon: number;
  alt_m: number;
  track: number | null;
};

/** Octave bands, in the order the detector reports them. */
export const OCTAVES = ["50-100", "100-200", "200-400", "400-800", "800-1600", "1600-3200"];

/**
 * The share of wall-clock time an event was active.
 *
 * This is the number the heard rate has to beat. If events cover a fifth of the
 * day, roughly a fifth of passes will overlap one by chance alone, so a heard
 * rate near this figure is coincidence rather than detection.
 */
export function noiseBaseline(stats: SensorStats | undefined): number | null {
  if (!stats || !stats.event_seconds_24h || !stats.observed_seconds) return null;
  // Divided by time actually observed, not a nominal 24 h: a sensor running for
  // an hour would otherwise report a reassuring 1% instead of the real 20%.
  return Math.min(1, stats.event_seconds_24h / stats.observed_seconds);
}

/**
 * The same baseline for the fleet as a whole.
 *
 * The heard rate above it pools every sensor, so its denominator has to pool
 * them too. Reading it off one arbitrary row - whichever PostgREST returned
 * first - made the headline flip between 21% and 4% between polls, which is
 * the difference between "this works" and "this is coincidence".
 */
export function fleetBaseline(stats: SensorStats[]): number | null {
  const events = stats.reduce((n, s) => n + (s.event_seconds_24h || 0), 0);
  const observed = stats.reduce((n, s) => n + (s.observed_seconds || 0), 0);
  if (!events || !observed) return null;
  return Math.min(1, events / observed);
}

/** Total listening time behind the pooled figures, in sensor-hours. */
export function fleetWindow(stats: SensorStats[]): string {
  const observed = stats.reduce((n, s) => n + (s.observed_seconds || 0), 0);
  if (!observed) return "no data yet";
  if (observed < 5400) return `${Math.max(1, Math.round(observed / 60))} min of listening`;
  return `${(observed / 3600).toFixed(1)} h of listening`;
}

/** Human-readable length of the observation window, for labelling the figures. */
export function observedWindow(stats: SensorStats | undefined): string {
  const s = stats?.observed_seconds;
  if (!s) return "no data yet";
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min of listening`;
  return `${(s / 3600).toFixed(1)} h of listening`;
}


/** Minutes and hours, the way someone watching a live map reads them. */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
  }
  return `${Math.floor(s / 86_400)} d ago`;
}

export type Verdict = "unexplained" | "aircraft";

/**
 * What a detection actually tells you.
 *
 * For drone work the interesting case is a sound nothing accounts for: a drone
 * broadcasts nothing, so an unmatched sound is the entire signal, and a matched
 * aircraft is a sound successfully ruled out.
 *
 * Wind never appears here - public_detections excludes it - so the counts in
 * public_sensor_stats are the only place it is visible, as context for why a
 * sensor is detecting poorly.
 */
export function verdict(d: PublicDetection): Verdict {
  return d.match_flight ? "aircraft" : "unexplained";
}

/**
 * How much weight a match deserves.
 *
 * With background noise filling ~14% of the time, plenty of matches are a
 * sound and an aircraft coinciding rather than one causing the other. Showing
 * a callsign as though it were established fact overstates what is known.
 */
export function matchConfidence(d: PublicDetection): "strong" | "fair" | "weak" {
  if (!d.match_flight) return "weak";
  const snr = d.snr_db ?? 0;
  const near = (d.match_slant_m ?? 99_999) < 6000;
  if (d.harmonic && snr > 20 && near) return "strong";
  if (snr > 15 && near) return "fair";
  return "weak";
}


/** A stable name, so a sensor does not change identity between polls. */
export function sensorName(s: PublicSensor, index: number): string {
  return s.label?.trim() || `Sensor ${index + 1}`;
}

/**
 * A sound nobody can account for, and not a brief one.
 *
 * This is the closest thing to a drone signal available today: a drone
 * broadcasts nothing, so it cannot be ruled out by ADS-B the way an aircraft
 * can. It is deliberately NOT called a drone - there is no classifier behind
 * it, and naming it that would be a claim the evidence does not support.
 *
 * Wind never reaches here; the agent tags it and the public view drops it.
 */
export function isUnaccounted(d: PublicDetection, minSeconds = 20): boolean {
  return !d.match_flight && d.duration_s >= minSeconds;
}

/**
 * The measured tilt distributions, from `public_spectrum_baseline`.
 *
 * This replaced a set of modelled reference curves. Checked against the data,
 * the model was wrong in a way worth recording: once normalised, wind,
 * confirmed aircraft and unmatched sounds all share the same octave *shape* at
 * this site - a monotonic decline of 8-12 dB per octave. What separates them is
 * the steepness of that decline, which is what low_tilt_db measures.
 *
 * So the only honest spectral question a single event can answer is "wind or
 * not wind". Aircraft type is not recoverable from six bands, and the page must
 * not imply otherwise.
 */
export type SpectrumBaseline = {
  population: "wind" | "aircraft" | "unmatched";
  n: number;
  /** Tilt in dB: the 50-100 Hz band minus the 200-400 Hz band. */
  p10: number;
  p50: number;
  p90: number;
};

export const POPULATION_LABEL: Record<SpectrumBaseline["population"], string> = {
  wind: "Wind",
  aircraft: "Confirmed aircraft",
  unmatched: "Unexplained",
};

/** Normalise octave levels in dB to a 0-1 shape for comparison. */
export function octaveShape(octaves: Record<string, number> | null): number[] | null {
  if (!octaves) return null;
  const v = OCTAVES.map((b) => octaves[b] ?? -90);
  const max = Math.max(...v);
  const min = Math.min(...v);
  const span = Math.max(max - min, 1);
  return v.map((x) => (x - min) / span);
}

/**
 * Stable numbering for sensors that have no name yet.
 *
 * "Sensor 1" is derived from position in a list, and PostgREST returns rows in
 * whatever order the planner produced - so between two polls the numbers
 * swapped and the panel looked as though it had jumped to a different sensor.
 * Sorting by id fixes the number to the sensor rather than to the row.
 */
export function sensorNames(sensors: PublicSensor[]): Record<string, string> {
  const ordered = [...sensors].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.fromEntries(ordered.map((s, i) => [s.id, sensorName(s, i)]));
}

/** Detections from the last `minutes` that nothing accounts for, by sensor. */
export function unaccountedBySensor(
  detections: PublicDetection[],
  minutes = 20
): Record<string, number> {
  const cutoff = Date.now() - minutes * 60_000;
  const out: Record<string, number> = {};
  for (const d of detections) {
    if (!isUnaccounted(d)) continue;
    if (new Date(d.started_at).getTime() < cutoff) continue;
    out[d.sensor_id] = (out[d.sensor_id] ?? 0) + 1;
  }
  return out;
}

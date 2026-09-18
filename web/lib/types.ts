/** Rows from `public_sensors` - coarsened to a ~1 km grid by the view. */
export type PublicSensor = {
  id: string;
  status: string;
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

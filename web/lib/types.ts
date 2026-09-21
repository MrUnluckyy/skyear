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
  /** The event hit the detector's length cap, so it is a slice, not a sound. */
  truncated: boolean;
  /** Prominence of the best harmonic spacing, dB. 0 means no regular structure. */
  comb_db: number | null;
  /** The spacing itself: a candidate blade-pass or engine firing rate. */
  comb_f0_hz: number | null;
  /** How many multiples of that spacing carry a resolvable tone. */
  n_harmonics: number | null;
  /** How much of the band sits in narrow peaks rather than broadband. */
  tonal_db: number | null;
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
  /** Passes in the window that cannot support a conclusion, and were dropped. */
  excluded_passes_24h: number;
};

/**
 * Conditions right now, per sensor.
 *
 * The 24 h duty cycle hides the thing a viewer most needs to know: whether the
 * map is currently measuring anything or just watching noise. On a windy
 * afternoon both sensors sat near 60% - six passes in ten would coincide with a
 * sound by chance - while the 24 h figure still read 19%.
 */
export type SensorConditions = {
  sensor_id: string;
  window_min: number;
  events: number;
  truncated: number;
  /** Share of the window with a sound in progress, 0-1. */
  duty: number;
};

/** How much a detection is worth right now, given what else is going on. */
export function conditionVerdict(duty: number): {
  label: string;
  note: string;
  tone: "good" | "fair" | "bad";
} {
  if (duty >= 0.5) {
    return {
      label: "saturated",
      note: "A sound is present most of the time, so most passes coincide with one by chance. Detections now mean very little.",
      tone: "bad",
    };
  }
  if (duty >= 0.25) {
    return {
      label: "noisy",
      note: "Background sound is frequent enough that a fair share of matches are coincidence.",
      tone: "fair",
    };
  }
  return {
    label: "quiet",
    note: "Background is quiet enough that a match is more likely to mean something.",
    tone: "good",
  };
}

/** Per-type figures pooled across sensors, for the fleet-wide rail. */
export function poolTypes(types: TypeStats[]): TypeStats[] {
  const by = new Map<string, TypeStats>();
  for (const t of types) {
    const prev = by.get(t.aircraft_type);
    if (!prev) {
      by.set(t.aircraft_type, { ...t, sensor_id: "*" });
      continue;
    }
    // Slant is averaged weighted by passes, not by sensor: a sensor with three
    // passes should not move the mean as much as one with thirty.
    const passes = prev.passes + t.passes;
    by.set(t.aircraft_type, {
      ...prev,
      passes,
      heard: prev.heard + t.heard,
      avg_slant_m: Math.round(
        (prev.avg_slant_m * prev.passes + t.avg_slant_m * t.passes) / Math.max(passes, 1)
      ),
    });
  }
  return [...by.values()].sort((a, b) => b.passes - a.passes);
}

export type TypeStats = {
  sensor_id: string;
  aircraft_type: string;
  passes: number;
  heard: number;
  avg_slant_m: number;
};

/** Live ADS-B aircraft, served by our own proxy - never fetched per browser. */
export type Aircraft = {
  /** Tail number. Often the only human-readable identity a light aircraft has. */
  reg?: string | null;
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


/**
 * Is this worth interrupting someone for?
 *
 * Most of what a microphone outdoors hears is traffic, wind and weather, and a
 * map that announces every one of them teaches people to ignore it. Attention
 * is reserved for what the project can actually stand behind: an aircraft the
 * geometry supports, or the class this exists to find.
 */
export function isNotable(d: PublicDetection): boolean {
  if (d.class === "drone") return true;
  return matchConfidence(d) !== "weak";
}

/**
 * Airframe families, because ICAO type codes split things nobody wants split.
 *
 * A320, A20N and A21N are one aeroplane to everyone except a spotter, and
 * listing them separately filled the rail with rows that looked like
 * duplicates while hiding the comparison that matters - do propellers carry
 * further than jets, do small aircraft go unheard.
 */
const FAMILY_RULES: [RegExp, string][] = [
  // Order matters: the first match wins, so the narrow cases come first.
  [/^(EC|AS[35]|H1[0-9]|R4[04]|R66|S76|AW1|B06|B4[02]9|B505|MI8|KA32)/, "Helicopter"],
  [/^(A400|C17|C130|K35R|P8|E3TF|RC13|F16|F35|H60)/, "Military"],
  [/^BCS[13]$/, "A220 family"],
  [/^A3(18|19|20|21)$|^A2[01]N$/, "A320 family"],
  [/^B73[0-9]$|^B3[89]M$/, "737 family"],
  [/^A3(0|1|3|4|5|8)[0-9A-Z]$|^B7[4678][0-9A-Z]$/, "Widebody"],
  [/^CRJ|^E1[79][05]$|^E29[05]$|^E7[05]S$|^RJ(85|1H)$|^SU95$/, "Regional jet"],
  [/^AT[47][2-6]$|^DH8[A-D]$|^SB20$|^F50$|^SF34$|^JS[0-9]|^E120$|^C208$/, "Turboprop airliner"],
  [/^C1[0-9]{2}$|^C20[0-6]$|^P[A2]8|^PA[0-9]{2}$|^S(R2[02]|22T)$|^DA[04][0-2]$|^TBM[0-9]|^DV20$|^AT3$|^GLID$/, "Light aircraft"],
  [/^C(2[5-9]|5|6|7)[0-9A-Z]{1,2}$|^CL[36]0$|^GLF[0-9]|^LJ[0-9]{2}$|^E5[05][0P]$|^E35L$|^E545$|^H25B$|^PC(12|24)$|^BE(20|40|9L)$|^FA[0-9]|^F2TH$|^GALX$|^EA50$|^PRM1$/, "Business jet"],
  [/^unknown$/i, "Unknown type"],
];

export function typeFamily(code: string): string {
  for (const [re, label] of FAMILY_RULES) if (re.test(code)) return label;
  return code;
}

/** The same pooling as poolTypes, one level up: by family rather than type. */
export function poolFamilies(types: TypeStats[]): (TypeStats & { members: string[] })[] {
  const by = new Map<string, TypeStats & { members: string[] }>();
  for (const t of poolTypes(types)) {
    const key = typeFamily(t.aircraft_type);
    const prev = by.get(key);
    if (!prev) {
      by.set(key, { ...t, aircraft_type: key, members: [t.aircraft_type] });
      continue;
    }
    const passes = prev.passes + t.passes;
    by.set(key, {
      ...prev,
      passes,
      heard: prev.heard + t.heard,
      avg_slant_m: Math.round(
        (prev.avg_slant_m * prev.passes + t.avg_slant_m * t.passes) / Math.max(passes, 1)
      ),
      members: [...prev.members, t.aircraft_type],
    });
  }
  return [...by.values()].sort((a, b) => b.passes - a.passes);
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
  // A truncated event is a slice of something that did not stop - a road, a
  // generator, rain on a roof. Counting each slice as its own unexplained sound
  // turned one continuous noise into nine separate "findings".
  return !d.match_flight && !d.truncated && d.duration_s >= minSeconds;
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


/**
 * Whether a sound has the narrowband structure of a turning rotor.
 *
 * Measured, on corrected synthesis at 0 dB SNR: this separates rotor sources
 * from wind, road noise and jets at AUC 1.000, and separates a drone from a
 * SCOOTER at AUC 0.500 - which is to say, not at all. Both are small engines
 * turning something in the same frequency range, and one microphone cannot
 * tell them apart on spectrum. That is a fact about physics, not a gap in the
 * implementation.
 *
 * So this returns "has a rotor" and never "is a drone". The step from one to
 * the other needs geometry - altitude, motion, and several sensors hearing the
 * same thing at once - and until that exists nothing here may turn red.
 */
export type RotorReading = {
  present: boolean;
  /** 0-1, how clearly the comb stands out. NOT a probability of a drone. */
  strength: number;
  label: string;
  note: string;
};

/** Harmonics needed before a comb is worth mentioning at all. */
export const ROTOR_MIN_HARMONICS = 4;

export function rotorReading(d: PublicDetection): RotorReading | null {
  if (d.n_harmonics == null || d.comb_db == null) return null;
  const n = d.n_harmonics;
  const f0 = d.comb_f0_hz ?? 0;

  if (n < ROTOR_MIN_HARMONICS) {
    return {
      present: false,
      strength: 0,
      label: "no rotor signature",
      note: "No regular harmonic stack. Wind, road noise and jet aircraft all look like this.",
    };
  }
  // Saturating rather than linear: the difference between four harmonics and
  // eight is large, between twelve and sixteen it is not.
  const strength = Math.min(1, (n - ROTOR_MIN_HARMONICS) / 8 + Math.min(d.comb_db, 12) / 24);
  return {
    present: true,
    strength,
    label: `rotor signature · ${n} harmonics`,
    note:
      f0 > 0
        ? `Something is turning at about ${f0.toFixed(0)} Hz. A propeller, an engine, or a scooter — this measurement does not separate them.`
        : "A regular harmonic stack, the mark of something turning.",
  };
}

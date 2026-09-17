/** Rows from `public_sensors` - coarsened to a ~1 km grid by the view. */
export type PublicSensor = {
  id: string;
  status: string;
  lat: number;
  lon: number;
  online: boolean;
};

/** Rows from `public_detections`. Drone rows arrive with match fields nulled. */
export type PublicDetection = {
  id: string;
  sensor_id: string;
  class: "unknown" | "aircraft" | "drone" | "noise";
  started_at: string;
  duration_s: number;
  match_flight: string | null;
  match_type: string | null;
  match_slant_m: number | null;
  match_bearing: number | null;
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

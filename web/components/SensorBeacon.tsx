"use client";

import { OCTAVES, type PublicDetection, type SensorPhase } from "@/lib/types";

/**
 * A sensor, drawn as an ear rather than a radar station.
 *
 * The rings collapse inward because that is what sound does: wavefronts arrive
 * at a microphone, they never leave it. Every other map in this space sweeps
 * outward, which is both a cliche and, for a passive listener, backwards.
 */
const PHASE_STYLE: Record<SensorPhase, { colour: string; ring: string; stagger: number }> = {
  offline: { colour: "var(--slate-dim)", ring: "", stagger: 0 },
  warming: { colour: "var(--slate)", ring: "ring-warming", stagger: 1.67 },
  listening: { colour: "var(--sodium)", ring: "", stagger: 1.13 },
  rising: { colour: "var(--sodium)", ring: "ring-rising", stagger: 0.67 },
  hearing: { colour: "var(--signal)", ring: "ring-hearing", stagger: 0.38 },
};

export function SensorBeacon({
  phase,
  flareKey,
  bearing,
  label,
  detail,
  count = 0,
}: {
  phase: SensorPhase;
  flareKey: number;
  bearing: number | null;
  label: string;
  detail?: string;
  /** More than one sensor at this point, shown on the marker itself. */
  count?: number;
}) {
  const { colour, ring, stagger } = PHASE_STYLE[phase];
  const live = phase !== "offline";
  const hearing = phase === "hearing";

  return (
    <div className="pointer-events-none relative" aria-hidden>
      {/*
        Arriving wavefronts, staggered so they read as a sequence rather than a
        pulse. They speed up as the sensor picks something up, which is the
        whole feedback loop: you can see it working without reading a number.
      */}
      {live &&
        [0, 1, 2].map((i) => (
          <span
            key={i}
            className={`ring-arrive ${ring} absolute rounded-full border`}
            style={{
              inset: -46,
              borderColor: colour,
              animationDelay: `${i * stagger}s`,
            }}
          />
        ))}

      {/*
        Where the sound came from. Drawn only on arrival and only when the agent
        resolved a bearing - it is evidence, not decoration, so it fades out.
      */}
      {bearing !== null && (
        <span
          key={`ray-${flareKey}`}
          className="bearing-ray absolute h-px"
          style={{
            width: 88,
            left: 0,
            top: 0,
            background: `linear-gradient(90deg, ${colour}, transparent)`,
            transform: `rotate(${bearing - 90}deg)`,
            transformOrigin: "left center",
          }}
        />
      )}

      {/* The ear itself. It sustains while a sound is actually being heard. */}
      {count <= 1 && (
        <span
          key={`ear-${flareKey}`}
          className={`absolute block rounded-full ${hearing ? "sustain" : ""} ${
            flareKey > 0 && !hearing ? "ear-flare" : ""
          }`}
          style={{
            inset: hearing ? -7 : -5,
            background: colour,
            boxShadow: live ? `0 0 12px ${colour}` : "none",
          }}
        />
      )}
      {count > 1 && (
        <span
          className="absolute flex items-center justify-center rounded-full font-mono text-[10px] font-medium"
          style={{
            inset: -9,
            background: "var(--night-deep)",
            border: `1.5px solid ${colour}`,
            color: colour,
          }}
        >
          {count}
        </span>
      )}
      <span
        className="absolute whitespace-nowrap font-mono text-[10px] tracking-tight"
        style={{ top: 14, left: -10, color: colour }}
      >
        {label}
        {detail && <span className="ml-1 opacity-70">{detail}</span>}
      </span>
    </div>
  );
}

/**
 * Octave levels for one event.
 *
 * Wind slumps hard from the bottom band; an aircraft carries energy into the
 * middle. Showing the shape lets you judge a detection instead of trusting it.
 */
export function OctaveBars({ octaves }: { octaves: Record<string, number> | null }) {
  if (!octaves) return null;
  const values = OCTAVES.map((band) => octaves[band] ?? -90);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);

  return (
    <div className="flex h-8 items-end gap-[3px]" title="Octave band levels, 50 Hz to 3.2 kHz">
      {values.map((v, i) => {
        const height = Math.max(2, ((v - min) / span) * 100);
        // Energy stuck in the bottom two bands is the wind signature.
        const low = i < 2;
        return (
          <span
            key={OCTAVES[i]}
            className="w-[7px] rounded-[1px]"
            style={{
              height: `${height}%`,
              background: low ? "var(--noise)" : "var(--frost)",
              opacity: 0.45 + (height / 100) * 0.55,
            }}
          />
        );
      })}
    </div>
  );
}

/** One line in the feed. */
export function DetectionRow({
  detection,
  active,
}: {
  detection: PublicDetection;
  active: boolean;
}) {
  const d = detection;
  const time = new Date(d.started_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const matched = Boolean(d.match_flight);

  return (
    <li
      className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 border-l-2 py-2 pl-3 transition-colors ${
        active ? "border-l-sodium bg-haze/70" : "border-l-transparent"
      }`}
    >
      <span className="font-mono text-[11px] text-slate-dim">{time}</span>
      <span className="min-w-0">
        <span className={`block truncate text-[13px] ${matched ? "text-bone" : "text-slate"}`}>
          {d.match_flight ?? "No aircraft overhead"}
        </span>
        <span className="font-mono text-[10px] text-slate-dim">
          {d.match_type ? `${d.match_type} · ` : ""}
          {d.match_slant_m ? `${(d.match_slant_m / 1000).toFixed(1)} km · ` : ""}
          {d.snr_db !== null ? `${d.snr_db.toFixed(0)} dB · ` : ""}
          {d.dominant_hz !== null ? `${d.dominant_hz.toFixed(0)} Hz` : ""}
        </span>
      </span>
      <span className="font-mono text-[11px] text-slate-dim">{Math.round(d.duration_s)}s</span>
    </li>
  );
}

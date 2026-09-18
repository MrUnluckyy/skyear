"use client";

import {
  OCTAVES,
  POPULATION_LABEL,
  matchConfidence,
  octaveShape,
  rotorReading,
  type PublicDetection,
  type SpectrumBaseline,
} from "@/lib/types";

const BAND_LABELS = ["50", "100", "200", "400", "800", "1.6k"];

const POPULATION_COLOUR: Record<SpectrumBaseline["population"], string> = {
  wind: "var(--noise)",
  aircraft: "var(--signal)",
  unmatched: "var(--sodium)",
};

/**
 * What this sound looked like, in six octave bands.
 *
 * The shape alone answers less than it appears to. Measured here, wind,
 * confirmed aircraft and unexplained sounds all fall away at 8-12 dB per
 * octave; normalise them and the curves lie on top of each other. So the bars
 * are shown as a fingerprint, not as evidence of a source, and the judgement is
 * left to the tilt scale below, which is the part that separates.
 */
export function SoundProfile({ detection }: { detection: PublicDetection }) {
  const shape = octaveShape(detection.octave_db);
  if (!shape) return null;

  const W = 300;
  const H = 76;
  const pad = { l: 34, r: 8, t: 6, b: 16 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / (OCTAVES.length - 1)) * plotW;
  const y = (v: number) => pad.t + (1 - v) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
         aria-label="Octave band levels for this sound, 50 Hz to 3.2 kHz">
      {shape.map((v, i) => (
        <rect
          key={OCTAVES[i]}
          x={x(i) - 9}
          y={y(v)}
          width={18}
          height={Math.max(1, y(0) - y(v))}
          rx={1}
          fill={i < 2 ? "var(--noise)" : "var(--frost)"}
          opacity={0.32 + v * 0.45}
        />
      ))}
      {BAND_LABELS.map((label, i) => (
        <text key={label} x={x(i)} y={H - 4} textAnchor="middle" className="fill-slate-dim"
              style={{ fontSize: 7.5, fontFamily: "var(--font-mono)" }}>
          {label}
        </text>
      ))}
      <text x={0} y={y(1) + 3} className="fill-slate-dim"
            style={{ fontSize: 7.5, fontFamily: "var(--font-mono)" }}>loud</text>
      <text x={0} y={y(0) + 3} className="fill-slate-dim"
            style={{ fontSize: 7.5, fontFamily: "var(--font-mono)" }}>quiet</text>
      <text x={x(0) - 10} y={H - 4} textAnchor="end" className="fill-slate-dim"
            style={{ fontSize: 7.5, fontFamily: "var(--font-mono)" }}>Hz</text>
    </svg>
  );
}

/**
 * Where this sound's tilt falls among sounds already recorded here.
 *
 * Tilt is the 50-100 Hz band minus the 200-400 Hz band: how fast the sound dies
 * away with frequency. Wind dies fast. Everything else dies more slowly, and
 * that is the one spectral distinction this sensor can actually make.
 *
 * The comparison populations are ADS-B-labelled and measured on site, not
 * modelled - which is why they are fetched rather than written down. The
 * unexplained band is the interesting one: it sits on the aircraft, not on the
 * wind.
 */
export function TiltScale({
  detection,
  baseline,
}: {
  detection: PublicDetection;
  baseline: SpectrumBaseline[];
}) {
  const tilt = detection.low_tilt_db;
  if (tilt == null || baseline.length === 0) return null;

  // One axis wide enough to hold every population and this sound.
  const lo = Math.min(tilt, ...baseline.map((b) => b.p10)) - 2;
  const hi = Math.max(tilt, ...baseline.map((b) => b.p90)) + 2;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;

  const order: SpectrumBaseline["population"][] = ["wind", "unmatched", "aircraft"];
  const rows = order
    .map((p) => baseline.find((b) => b.population === p))
    .filter((b): b is SpectrumBaseline => Boolean(b));

  // Which population this sound's tilt actually falls inside.
  const inside = rows.filter((b) => tilt >= b.p10 && tilt <= b.p90);

  return (
    <div>
      <p className="text-[11px] text-slate">
        How fast it died away with frequency:{" "}
        <span className="font-mono text-bone">{tilt.toFixed(0)} dB</span>
      </p>

      <div className="mt-2 space-y-1.5">
        {rows.map((b) => {
          const hit = tilt >= b.p10 && tilt <= b.p90;
          return (
            <div key={b.population} className="grid grid-cols-[76px_1fr] items-center gap-2">
              <span className={`text-[10px] ${hit ? "text-bone" : "text-slate-dim"}`}>
                {POPULATION_LABEL[b.population]}
              </span>
              <span className="relative block h-3">
                {/* p10 to p90: where eight in ten of that population sit. */}
                <span
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${pct(b.p10)}%`,
                    width: `${pct(b.p90) - pct(b.p10)}%`,
                    background: POPULATION_COLOUR[b.population],
                    opacity: hit ? 0.55 : 0.22,
                  }}
                />
                <span
                  className="absolute top-1/2 h-2.5 w-px -translate-y-1/2"
                  style={{ left: `${pct(b.p50)}%`, background: POPULATION_COLOUR[b.population] }}
                />
              </span>
            </div>
          );
        })}

        {/* This sound, on the same axis. */}
        <div className="grid grid-cols-[76px_1fr] items-center gap-2">
          <span className="text-[10px] text-bone">This sound</span>
          <span className="relative block h-3">
            <span
              className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2"
              style={{ left: `${pct(tilt)}%`, background: "var(--bone)" }}
            />
          </span>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-slate">
        {inside.length === 0
          ? (() => {
              // Falling between two populations is the common case and says
              // something; falling beyond all of them says something else.
              const below = rows.filter((b) => tilt > b.p90);
              const above = rows.filter((b) => tilt < b.p10);
              if (below.length && above.length) {
                return `That sits between ${POPULATION_LABEL[below[0].population].toLowerCase()} and ${POPULATION_LABEL[above[above.length - 1].population].toLowerCase()} — the measurement does not commit either way.`;
              }
              return "This tilt falls outside every population recorded here so far.";
            })()
          : inside.length === 1
            ? `That puts it among ${POPULATION_LABEL[inside[0].population].toLowerCase()} sounds (${inside[0].n} recorded).`
            : `That range overlaps ${inside.map((b) => POPULATION_LABEL[b.population].toLowerCase()).join(" and ")}, so tilt alone does not decide it.`}{" "}
        Bands cover the middle eight tenths of each group.
      </p>
    </div>
  );
}

/** Everything measured about one sound, in the order a person would ask. */
export function SoundFacts({ detection: d }: { detection: PublicDetection }) {
  const rows: [string, string][] = [
    ["Lasted", `${Math.round(d.duration_s)} seconds`],
    ["Loudness over background", d.snr_db != null ? `${d.snr_db.toFixed(0)} dB` : "—"],
    ["Strongest frequency", d.dominant_hz != null ? `${d.dominant_hz.toFixed(0)} Hz` : "—"],
  ];

  if (d.match_flight) {
    rows.push(["Aircraft overhead", `${d.match_flight}${d.match_type ? ` · ${d.match_type}` : ""}`]);
    if (d.match_slant_m != null) rows.push(["Its distance", `${(d.match_slant_m / 1000).toFixed(1)} km`]);
    if (d.match_delay_s != null) rows.push(["Sound lagged it by", `${d.match_delay_s.toFixed(1)} s`]);
    rows.push(["Confidence in the match", matchConfidence(d)]);
  } else {
    rows.push(["Aircraft overhead", "none — nothing accounts for this"]);
  }

  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-dim">{k}</dt>
          <dd className="text-right font-mono text-bone">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What the periodicity feature says, and why it is shown last.
 *
 * Calibrated on synthetic engine sound it worked; in the field it does not.
 * Every population measured here averages 0.066-0.073, wind and confirmed
 * piston aircraft alike. Showing the number without that context would invite
 * exactly the wrong conclusion.
 */
export function PeriodicityNote({ detection: d }: { detection: PublicDetection }) {
  if (d.cpp_db == null) return null;
  return (
    <p className="text-[11px] leading-snug text-slate-dim">
      Repetition score <span className="font-mono text-slate">{d.cpp_db.toFixed(3)}</span>
      {d.harmonic && d.f0_hz ? ` (repeating near ${d.f0_hz.toFixed(0)} Hz)` : ""} — recorded, but
      not yet meaningful: wind and confirmed propeller aircraft both average about 0.07 here, so
      this number does not separate them.
    </p>
  );
}


/**
 * Is something turning?
 *
 * Deliberately two states and no percentage. A number like "87% drone" would be
 * invented: the feature behind this separates rotors from wind, road noise and
 * jets perfectly, and drones from scooters not at all. Printing a confidence
 * would claim a distinction the measurement cannot make, and a red dot on a
 * map is exactly the place where that claim would do damage.
 */
export function RotorSignature({ detection }: { detection: PublicDetection }) {
  const r = rotorReading(detection);
  if (!r) return null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-dim">Rotor</span>
        <span className={`text-[11.5px] ${r.present ? "text-sodium" : "text-slate"}`}>
          {r.label}
        </span>
      </div>
      {r.present && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-haze">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.round(r.strength * 100)}%`, background: "var(--sodium)" }}
          />
        </div>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-slate-dim">{r.note}</p>
      {r.present && (
        <p className="mt-1 text-[11px] leading-snug text-slate-dim">
          This is not a drone detection. Telling a drone from a scooter needs altitude and more
          than one sensor hearing it at once — neither of which SkyEar can do yet.
        </p>
      )}
    </div>
  );
}

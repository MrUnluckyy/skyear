"use client";

import {
  OCTAVES,
  ago,
  matchConfidence,
  noiseBaseline,
  sensorPhase,
  verdict,
  type PublicDetection,
  type PublicSensor,
  type SensorStats,
  type TypeStats,
} from "@/lib/types";

/**
 * Six octave levels as a fingerprint.
 *
 * Built from data already stored, so it needs no audio upload and no privacy
 * review. Wind slumps into the bottom two bands; an engine carries energy into
 * the middle, which is the shape worth recognising at a glance.
 */
function Fingerprint({ octaves, wide = false }: { octaves: Record<string, number> | null; wide?: boolean }) {
  if (!octaves) return <span className="text-[10px] text-slate-dim">no spectrum</span>;
  const v = OCTAVES.map((b) => octaves[b] ?? -90);
  const max = Math.max(...v);
  const min = Math.min(...v);
  const span = Math.max(max - min, 1);
  return (
    <div className={`flex items-end gap-[2px] ${wide ? "h-9" : "h-5"}`} title="50 Hz to 3.2 kHz">
      {v.map((x, i) => (
        <span
          key={OCTAVES[i]}
          className={wide ? "w-2 rounded-[1px]" : "w-[5px] rounded-[1px]"}
          style={{
            height: `${Math.max(3, ((x - min) / span) * 100)}%`,
            background: i < 2 ? "var(--noise)" : "var(--frost)",
            opacity: 0.5 + ((x - min) / span) * 0.5,
          }}
        />
      ))}
    </div>
  );
}

function Health({ sensor, stats }: { sensor: PublicSensor; stats?: SensorStats }) {
  /*
   * A quiet sensor is ambiguous: quiet sky, or dead camera? An operator has to
   * be able to tell those apart, so state comes before statistics here.
   */
  const rows: [string, string, string][] = [
    [
      "Agent",
      sensor.online ? "reporting" : "not reporting",
      sensor.online ? "text-signal" : "text-bad",
    ],
    [
      "Audio",
      !sensor.online
        ? "—"
        : sensor.audio === null
          // The agent is too old to say. It is plainly receiving something if
          // it has a noise floor, so do not imply a fault.
          ? sensor.warm
            ? "measuring a noise floor"
            : "not reported"
          : sensor.audio
            ? "reaching the detector"
            : "no sound arriving",
      sensor.online && sensor.audio === false ? "text-bad" : "text-bone",
    ],
    [
      "Noise floor",
      sensor.warm
        ? stats?.avg_floor_db != null
          ? `${stats.avg_floor_db} dB average`
          : "settled"
        : "still settling",
      "text-bone",
    ],
    [
      "Last report",
      sensor.reported_at ? ago(sensor.reported_at) : "never",
      "text-bone",
    ],
  ];

  return (
    <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
      {rows.map(([k, v, cls]) => (
        <div key={k} className="contents">
          <dt className="text-slate-dim">{k}</dt>
          <dd className={cls}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What this ear has proven it can hear, from its own pass record. */
function MeasuredRange({ types }: { types: TypeStats[] }) {
  const shown = types.filter((t) => t.passes >= 3).slice(0, 6);
  if (!shown.length) {
    return <p className="text-[12px] text-slate-dim">Not enough passes yet to say.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {shown.map((t) => {
        const rate = t.passes ? t.heard / t.passes : 0;
        return (
          <li key={t.aircraft_type} className="grid grid-cols-[44px_1fr_auto] items-center gap-2">
            <span className="font-mono text-[11px] text-bone">{t.aircraft_type}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-haze">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(rate * 100, t.heard ? 5 : 0)}%`,
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
  );
}

function DetectionLine({ d }: { d: PublicDetection }) {
  const kind = verdict(d);
  const confidence = matchConfidence(d);
  const unexplained = kind === "unexplained";

  return (
    <li
      className={`grid grid-cols-[1fr_auto] items-start gap-3 border-l-2 py-2.5 pl-3 ${
        unexplained ? "border-l-sodium bg-sodium/[0.06]" : "border-l-transparent"
      }`}
    >
      <div className="min-w-0">
        <p className={`text-[13px] ${unexplained ? "text-sodium" : "text-bone"}`}>
          {unexplained ? "Unexplained sound" : d.match_flight}
          {!unexplained && confidence !== "strong" && (
            <span className="ml-1.5 text-[10px] text-slate-dim">
              {confidence === "weak" ? "· weak match" : "· probable"}
            </span>
          )}
        </p>
        <p className="mt-0.5 font-mono text-[10.5px] text-slate-dim">
          {ago(d.started_at)} · {Math.round(d.duration_s)}s
          {d.snr_db != null && ` · ${d.snr_db.toFixed(0)} dB`}
          {d.harmonic && " · periodic"}
          {!unexplained && d.match_type && ` · ${d.match_type}`}
          {!unexplained && d.match_slant_m != null && ` · ${(d.match_slant_m / 1000).toFixed(1)} km`}
        </p>
      </div>
      <Fingerprint octaves={d.octave_db} />
    </li>
  );
}

export default function SensorPanel({
  sensor,
  stats,
  types,
  detections,
  siblings = [],
  onSelect,
  onClose,
}: {
  sensor: PublicSensor;
  stats?: SensorStats;
  types: TypeStats[];
  detections: PublicDetection[];
  /** Every sensor sharing this marker, including this one. */
  siblings?: PublicSensor[];
  onSelect?: (id: string) => void;
  onClose: () => void;
}) {
  const mine = detections.filter((d) => d.sensor_id === sensor.id);
  const unexplained = mine.filter((d) => verdict(d) === "unexplained");
  const baseline = noiseBaseline(stats);
  const rate = stats?.passes_24h ? stats.heard_24h / stats.passes_24h : null;

  return (
    <aside className="absolute inset-x-0 bottom-0 z-20 flex max-h-[72dvh] flex-col border-t border-edge bg-night/95 backdrop-blur-xl md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-[368px] md:border-l md:border-t-0">
      <div className="flex justify-center pt-2 md:hidden" aria-hidden>
        <span className="h-1 w-9 rounded-full bg-edge" />
      </div>
      <header className="flex items-start justify-between border-b border-edge px-5 py-3 md:py-4">
        <div>
          <h2 className="text-[15px] text-bone">Sensor</h2>
          <p className="mt-0.5 font-mono text-[11px] text-slate-dim">
            {sensor.lat.toFixed(2)}, {sensor.lon.toFixed(2)} · approximate
          </p>
          {siblings.length > 1 && (
            <p className="mt-1 max-w-[30ch] text-[11px] leading-snug text-slate-dim">
              {siblings.length} sensors share this point. Positions are rounded to
              about a kilometre, so neighbours arrive together.
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded border border-edge px-2 py-0.5 text-[12px] text-slate hover:border-sodium hover:text-sodium"
          aria-label="Close sensor details"
        >
          Close
        </button>
      </header>

      {/* Stacked sensors never separate by zooming, so the only way to reach
          them is to switch between them here. */}
      {siblings.length > 1 && onSelect && (
        <nav className="flex gap-1.5 border-b border-edge px-5 py-3">
          {siblings.map((s, i) => {
            const active = s.id === sensor.id;
            const phase = sensorPhase(s);
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${
                  active
                    ? "border-sodium/60 bg-sodium/10 text-sodium"
                    : "border-edge text-slate hover:border-sodium/40"
                }`}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background:
                      phase === "hearing"
                        ? "var(--signal)"
                        : phase === "offline"
                          ? "var(--slate-dim)"
                          : "var(--sodium)",
                  }}
                />
                Sensor {i + 1}
              </button>
            );
          })}
        </nav>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto">
        <section className="border-b border-edge px-5 py-4">
          <Health sensor={sensor} stats={stats} />
        </section>

        {/* The drone case: sound nobody can account for. */}
        <section className="border-b border-edge px-5 py-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[12px] text-slate">Unexplained sounds</h3>
            <span className="font-mono text-[11px] text-sodium">
              {unexplained.length} of {mine.length}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-dim">
            A drone broadcasts nothing, so a sound with no aircraft overhead is the thing worth
            looking at. Wind is filtered out before it reaches this list.
          </p>
          {baseline !== null && rate !== null && (
            <p className="mt-2 text-[11px] leading-snug text-slate-dim">
              This sensor heard{" "}
              <span className="font-mono text-bone">{Math.round(rate * 100)}%</span> of aircraft
              against a{" "}
              <span className="font-mono text-noise">{Math.round(baseline * 100)}%</span> chance
              baseline.
            </p>
          )}
        </section>

        <section className="border-b border-edge px-5 py-4">
          <h3 className="text-[12px] text-slate">What it has proven it can hear</h3>
          <div className="mt-3">
            <MeasuredRange types={types.filter((t) => t.sensor_id === sensor.id)} />
          </div>
        </section>

        <section className="px-5 py-4">
          <h3 className="mb-1 text-[12px] text-slate">Recently heard</h3>
          {mine.length === 0 ? (
            <p className="mt-2 text-[12px] text-slate-dim">Nothing yet.</p>
          ) : (
            <ul>
              {mine.slice(0, 30).map((d) => (
                <DetectionLine key={d.id} d={d} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

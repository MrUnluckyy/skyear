import SiteNav from "@/components/SiteNav";

/**
 * What every graphic on the map means.
 *
 * Written because the charts encode findings that are not self-evident, and a
 * chart nobody can read is worse than no chart - it invites people to invent an
 * interpretation. Each section says what is measured, how to read it, and what
 * it cannot tell you, in that order.
 */

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 overflow-x-auto border border-edge bg-night-deep/60 p-4">{children}</div>
  );
}

function Section({
  title,
  where,
  children,
}: {
  title: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-edge py-8">
      <p className="font-mono text-[11px] text-slate-dim">{where}</p>
      <h2 className="mt-1 text-[19px] text-bone">{title}</h2>
      <div className="mt-3 max-w-[68ch] space-y-3 text-[14px] leading-relaxed text-slate">
        {children}
      </div>
    </section>
  );
}

function Cannot({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-l-2 border-bad/50 pl-3 text-[13.5px] leading-relaxed text-slate-dim">
      <span className="text-bad">What it cannot tell you. </span>
      {children}
    </p>
  );
}

export default function Reading() {
  return (
    <main className="min-h-dvh bg-night-deep px-6 py-12 text-bone">
      <div className="mx-auto max-w-3xl">
        <SiteNav current="/reading" />

        <h1 className="mt-8 text-[30px] leading-tight tracking-tight">Reading the map</h1>
        <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-slate">
          Every figure here is measured on this network, and most of them exist to stop you
          believing something. The single most important number is not the detection rate — it is
          the share of time a sound is present at all, because that is what a detection has to beat
          before it means anything.
        </p>

        <Section where="Left rail, the large number" title="Passes heard">
          <p>
            Every aircraft that broadcasts ADS-B and comes within range of a sensor is recorded as a{" "}
            <em>pass</em>, whether or not anything was heard. The percentage is how many of those
            passes had a sound at the moment the sound would have arrived — distance divided by
            343 m/s, not the moment the aircraft was overhead.
          </p>
          <p>
            Counting the misses is the entire point. A network that only recorded its successes
            could not tell you its range, and the not-heard passes are what a classifier will
            eventually be trained against.
          </p>
          <Cannot>
            Nothing on its own. A heard rate of 40% is excellent if background noise fills 10% of
            the time and meaningless if it fills 40%. Always read it against the bar below it.
          </Cannot>
        </Section>

        <Section where="Left rail, the thin bar" title="The coincidence baseline">
          <p>
            The filled bar is the heard rate. The vertical line across it is the share of time a
            sound — any sound — was in progress. If sounds fill a fifth of the day then roughly a
            fifth of passes will overlap one by chance, with no detection involved at all.
          </p>
          <Figure>
            <div className="max-w-sm">
              <div className="relative h-1.5 overflow-hidden rounded-full bg-haze">
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: "44%", background: "var(--sodium)" }} />
                <div className="absolute inset-y-0 w-px" style={{ left: "21%", background: "var(--noise)" }} />
              </div>
              <p className="mt-2 font-mono text-[11px] text-slate-dim">
                44% heard · baseline 21% — detection
              </p>
              <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-haze">
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: "56%", background: "var(--sodium)" }} />
                <div className="absolute inset-y-0 w-px" style={{ left: "74%", background: "var(--noise)" }} />
              </div>
              <p className="mt-2 font-mono text-[11px] text-slate-dim">
                56% heard · baseline 74% — coincidence
              </p>
            </div>
          </Figure>
          <p>
            The second bar is the trap, and it is a real afternoon from this network. A higher
            number can be worth less. Only the gap between the fill and the line means anything.
          </p>
        </Section>

        <Section where="Left rail and sensor panel" title="Conditions right now">
          <p>
            The 24-hour baseline above is an average, and averages hide weather. This figure is the
            share of the last hour with a sound in progress, for the busiest live sensor. Under 25%
            a match is worth something; over 50% most matches are coincidence whatever the sensors
            do.
          </p>
          <Cannot>
            Whether the noise is wind, traffic, or rain. It measures how crowded the acoustic
            environment is, not what is crowding it.
          </Cannot>
        </Section>

        <Section where="Sensor panel, horizontal bars" title="Heard by aircraft type">
          <p>
            Passes and detections grouped by airframe. The bar is the heard fraction; the figures on
            the right are heard over total.
          </p>
          <Cannot>
            Almost anything, at present sample sizes. This view once showed the A220 at 1 of 17 and
            it was reported as the strongest finding in the project — engine loudness, apparently.
            It was an artefact of a 14-hour window when the agent&rsquo;s clock had drifted and
            matching was inoperative. With those passes removed the same aircraft sits at 6 of 13.
            Treat any type with fewer than about fifty passes as noise.
          </Cannot>
        </Section>

        <Section where="Detection detail, vertical bars" title="The octave fingerprint">
          <p>
            Six bars, each an octave wide, from 50 Hz to 3.2 kHz, showing where the sound&rsquo;s
            energy sat. The left two are drawn in a different colour because that is where wind
            lives.
          </p>
          <Cannot>
            What made the sound. This was tested directly: normalise the octave shapes of wind,
            ADS-B-confirmed aircraft and unexplained sounds recorded here and the three curves lie
            on top of each other — everything falls away at 8–12 dB per octave. An earlier version
            of this page drew modelled reference curves for &ldquo;jet&rdquo; and
            &ldquo;propeller&rdquo; and confidently mislabelled an Airbus A321 as a propeller. The
            curves were removed. Read the bars as a fingerprint for comparing two sounds, not as
            evidence of a source.
          </Cannot>
        </Section>

        <Section where="Detection detail, horizontal ranges" title="The tilt scale">
          <p>
            Tilt is the 50–100 Hz band minus the 200–400 Hz band: how steeply the sound dies away
            with frequency. It is the one spectral quantity here that separates anything, and the
            bands show where three measured populations actually sit — each covering the middle
            eight tenths of that group.
          </p>
          <Figure>
            <div className="max-w-sm space-y-2 font-mono text-[11px]">
              {[
                ["Wind", "20.4 – 26.4 dB", "n=204", "var(--noise)"],
                ["Confirmed aircraft", "14.5 – 19.2 dB", "n=56", "var(--signal)"],
                ["Unexplained", "11.6 – 19.3 dB", "n=304", "var(--sodium)"],
              ].map(([label, range, n, colour]) => (
                <div key={label} className="grid grid-cols-[130px_1fr_46px] items-center gap-2">
                  <span className="text-slate">{label}</span>
                  <span style={{ color: colour }}>{range}</span>
                  <span className="text-slate-dim">{n}</span>
                </div>
              ))}
            </div>
          </Figure>
          <p>
            Two things follow. The detector&rsquo;s wind threshold of 20 dB was set from two gusts
            on the first day; it turns out to sit almost exactly between wind&rsquo;s 10th
            percentile and confirmed aircraft&rsquo;s 90th. And the unexplained sounds sit on the
            aircraft distribution, not the wind one — whatever they are, they are not the wind
            filter leaking.
          </p>
          <Cannot>
            Separate one aircraft from another, or a drone from a lorry. It is a wind test.
          </Cannot>
        </Section>

        <Section where="Detection detail" title="Rotor signature">
          <p>
            A propeller or piston engine leaves a harmonic stack: tones at regular multiples of the
            blade-pass or firing rate. This measurement integrates the whole event, whitens the
            spectrum so only narrow peaks survive, and autocorrelates it to find the{" "}
            <em>spacing</em>. Spacing survives distance — air absorption removes the top of the
            stack but does not change the gap between what is left.
          </p>
          <p>
            On synthetic signals at 0 dB SNR it separates rotor sources from wind, road noise and
            jet aircraft perfectly.
          </p>
          <Cannot>
            Tell a drone from a scooter. Both are small engines turning something at around 100 Hz,
            and the same test scores that separation at chance. This is why the readout says
            &ldquo;rotor signature&rdquo; and never a percentage, and why nothing on this map turns
            red. A confidence figure here would be invented.
          </Cannot>
        </Section>

        <Section where="Map, dashed ring" title="Unexplained sounds">
          <p>
            A ring around a sensor means it has recently heard something lasting more than twenty
            seconds with no transponder-equipped aircraft overhead. It turns slowly rather than
            flashing, because the sound has already finished by the time it reaches the map.
          </p>
          <Cannot>
            Suggest a drone. Scooters, lorries, construction, rain on a roof and any aircraft
            without ADS-B all land here. &ldquo;Unexplained&rdquo; means unexplained{" "}
            <em>by ADS-B</em>, which is a much weaker statement than it sounds. Sounds that hit the
            four-minute event limit are excluded from the count entirely, because a continuous
            noise source would otherwise be reported as a new discovery every four minutes.
          </Cannot>
        </Section>

        <Section where="Map, the beacon" title="Sensor state">
          <p>
            Rings collapse inward rather than sweeping outward, because that is what sound does — a
            microphone receives wavefronts, it does not emit them. They speed up as the sensor picks
            something up. Grey is offline, amber is listening, green is hearing something at this
            instant.
          </p>
        </Section>

        <div className="border-t border-edge py-8">
          <h2 className="text-[19px] text-bone">The short version</h2>
          <ul className="mt-3 max-w-[68ch] space-y-2 text-[14px] leading-relaxed text-slate">
            <li>Check conditions before believing any detection.</li>
            <li>A heard rate means nothing except against the coincidence line.</li>
            <li>The octave bars compare sounds; they do not identify them.</li>
            <li>Tilt is a wind test and a good one.</li>
            <li>A rotor signature means something is turning, not that it is a drone.</li>
            <li>Nothing here turns red, because nothing here has earned it yet.</li>
          </ul>
        </div>
      </div>
    </main>
  );
}

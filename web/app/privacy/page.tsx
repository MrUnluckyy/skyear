import type { Metadata } from "next";
import Link from "next/link";

/**
 * What the project holds about people, in the terms it actually works in.
 *
 * Written because SkyEar asks strangers to point a microphone at their own
 * street and hand over an email address, which is a lot to ask without saying
 * plainly what leaves the machine. Every figure here is the real one: 3
 * decimal places is `LOCATION_DP` in agent/skyear/uploader.py, and the 0.01
 * grid is the snap in the public_sensors view.
 *
 * Keep this page honest with the code. If the agent ever uploads something new,
 * this page changes in the same commit.
 */

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What SkyEar stores, what never leaves your machine, and how to have your data deleted.",
};

const UPDATED = "20 September 2026";
const CONTACT = "privacy@skyear.lt";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-edge py-8">
      <h2 className="text-[19px] text-bone">{title}</h2>
      <div className="mt-3 max-w-[68ch] space-y-3 text-[14px] leading-relaxed text-slate">
        {children}
      </div>
    </section>
  );
}

export default function Privacy() {
  return (
    <main className="min-h-dvh bg-night-deep px-6 py-12 text-bone">
      <div className="mx-auto max-w-3xl">
        <nav className="flex gap-4 text-[13px]">
          <Link href="/" className="text-slate hover:text-sodium">
            Map
          </Link>
          <Link href="/reading" className="text-slate hover:text-sodium">
            How to read this
          </Link>
          <Link href="/join" className="text-slate hover:text-sodium">
            Become a sensor
          </Link>
        </nav>

        <h1 className="mt-8 text-[30px] leading-tight tracking-tight">Privacy</h1>
        <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-slate">
          SkyEar turns a microphone a security camera already has into an acoustic sensor for
          aircraft. That means audio, locations and email addresses, so here is exactly what is
          held and by whom. Last updated {UPDATED}.
        </p>

        <Section title="If you only look at the map">
          <p>
            Nothing is asked of you and nothing is stored about you. There is no analytics script,
            no advertising, no tracking pixel and no cookie banner, because there is nothing to
            consent to — the site sets no cookie until you sign in.
          </p>
          <p>
            Two third parties see your IP address because your browser fetches from them directly:
            CARTO and OpenStreetMap, for map tiles. Live aircraft positions come from{" "}
            <a href="https://adsb.lol" className="text-sodium hover:underline">
              adsb.lol
            </a>
            , but your browser never contacts them — the server fetches once and serves everyone
            the same cached copy, so adsb.lol never sees visitors at all.
          </p>
        </Section>

        <Section title="If you sign in">
          <p>
            Signing in stores one thing: your email address. It exists to send you a one-time link
            and to own the sensors you add. There is no password, so there is nothing to leak. The
            session is a cookie that identifies you to the database and nothing else.
          </p>
          <p>
            Email is sent through Resend, which sees the address and the message. Accounts and
            sensor data live in Supabase, hosted in the EU (Frankfurt). The site runs on Vercel.
          </p>
        </Section>

        <Section title="If you run a sensor">
          <p className="text-bone">
            Audio never leaves your machine. The camera password never leaves your machine.
          </p>
          <p>
            The agent runs on your own hardware, connects to your own camera on your own network,
            and uploads only what it concluded: the time a sound started, how long it lasted, how
            loud it was, a summary of its frequencies, and which aircraft was overhead if ADS-B
            explains it. Recordings stay on the machine that made them. Camera addresses and
            passwords are never sent anywhere, and the project is built so there is no server-side
            place to put them.
          </p>
          <p>
            <span className="text-bone">Location is deliberately imprecise.</span> The agent rounds
            your sensor&apos;s position to three decimal places — about 110 metres — before it is
            uploaded, so the exact spot is never transmitted or stored. The public map coarsens it
            again, snapping to a grid of roughly one kilometre. Nobody, including the project, can
            read your address off the map.
          </p>
          <p>
            Sensor labels are yours to choose and are shown publicly, so name a sensor after a
            neighbourhood rather than a person or a street number.
          </p>
          <p>
            Audio clips are uploaded only if you turn that on, per clip, and never automatically.
          </p>
        </Section>

        <Section title="Recording sound where other people live">
          <p>
            A microphone outdoors picks up more than aircraft. The agent is built to keep that
            local: detections are summaries, not recordings, and clips stay on your disk unless you
            deliberately send one.
          </p>
          <p>
            Running a microphone still carries obligations that are yours, not the project&apos;s.
            Point it at the sky rather than a neighbour&apos;s window, and do not share clips of
            people speaking.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            Detections and the aircraft they were matched against are kept indefinitely. They are
            the measurement the project exists to build — what a sensor heard, and what it missed —
            and they carry no identifying content.
          </p>
          <p>
            Your email address is kept until you ask for the account to be removed. Pairing codes
            expire after fifteen minutes and are single-use.
          </p>
        </Section>

        <Section title="Your data, and how to get it back or removed">
          <p>
            Under the GDPR you can ask for a copy of what is held about you, ask for it to be
            corrected, ask for it to be deleted, or object to it being held at all. Write to{" "}
            <a href={`mailto:${CONTACT}`} className="text-sodium hover:underline">
              {CONTACT}
            </a>{" "}
            and say which. Deleting an account removes the address and retires its sensors; past
            detections stay, without anything linking them to you.
          </p>
          <p>
            If you think this has been handled badly, you can complain to the Lithuanian State Data
            Protection Inspectorate (Valstybinė duomenų apsaugos inspekcija,{" "}
            <a href="https://vdai.lrv.lt" className="text-slate hover:text-sodium">
              vdai.lrv.lt
            </a>
            ).
          </p>
        </Section>

        <Section title="Changes">
          <p>
            This page changes when the software does. It is versioned in the repository alongside
            the code it describes, so the wording and the behaviour move together.
          </p>
        </Section>

        <footer className="border-t border-edge py-8 text-[13px] text-slate-dim">
          <Link href="/" className="text-slate hover:text-sodium">
            Back to the map
          </Link>
        </footer>
      </div>
    </main>
  );
}

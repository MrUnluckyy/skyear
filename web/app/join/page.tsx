import type { Metadata } from "next";

import SetupChooser from "@/components/SetupChooser";

export const metadata: Metadata = {
  title: "Become a sensor · SkyEar",
  description:
    "Step-by-step setup for turning a security camera you already own into an acoustic sensor for aircraft, starting in Lithuania.",
};

type Where = "browser" | "machine";

type Step = {
  where: Where;
  title: string;
  body: string;
  code?: string;
  /** Browser steps link rather than printing a URL: the reader is already in a
   *  browser, and a hardcoded domain is wrong on every other deployment. */
  link?: { href: string; label: string };
  expect?: string;
  stuck?: { problem: string; fix: string }[];
};

/**
 * Setup spans two places - a browser and the machine next to the camera - and
 * mixing them up is the thing that actually derails people. Every step is
 * labelled with where it happens.
 */
const STEPS: Step[] = [
  {
    where: "browser",
    title: "Tell it about your camera",
    body: "On the setup page: pick the make, type the camera's address on your network, and enter the username and password you use in its own app. Press Test this camera. This is the moment that decides whether your camera can be a sensor at all, and it needs no account and no sign-up.",
    expect: `Audio found — aac at 16000 Hz. This camera can be a sensor.`,
    stuck: [
      { problem: "\u201cThe camera rejected that username or password.\u201d", fix: "Reolink usually wants admin and the password you set in its app, not your Reolink cloud login." },
      { problem: "\u201cCould not reach the camera.\u201d", fix: "Check the address, and that RTSP is switched on in the camera settings. Most cameras have it off by default." },
      { problem: "\u201cThis camera streams video but no audio.\u201d", fix: "That model has no microphone, or it is disabled in the camera's settings. Check there first; if there is no microphone, this camera cannot be a sensor." },
      { problem: "The setup page does not load at all.", fix: "The agent log prints the exact address. In Docker it sometimes prints the container's own address, so use the machine's instead." },
    ],
  },
  {
    where: "browser",
    title: "Set where it is listening from",
    body: "Press Use my current location, or type the coordinates. The ground elevation is looked up for you; the mount height is roughly how high the camera is off the ground. Position matters because matching a sound to an aircraft is geometry — the distance decides how long the sound took to arrive.",
    expect: "Latitude and longitude filled in, and an elevation that looks plausible for where you are.",
    stuck: [
      { problem: "The browser refuses to share a location.", fix: "It only works on https or localhost. Type the coordinates instead — right-click your roof in Google Maps and copy the pair." },
    ],
  },
  {
    where: "browser",
    title: "Create an account and connect",
    body: "Only now, once you know the camera works. Enter your email, click the one-time link, press Generate pairing code, and paste that code into the setup page. Then press Save and connect.",
    link: { href: "/login", label: "Sign in" },
    expect: "Connected. Restart the agent and your sensor appears on the map within a minute.",
    stuck: [
      { problem: "No email after a minute.", fix: "Check spam — the first message from a new sender usually lands there. The link is single-use and expires in an hour." },
      { problem: "The code is rejected.", fix: "Codes expire after 15 minutes and work once. Generate another." },
    ],
  },
  {
    where: "browser",
    title: "Watch it start listening",
    body: "Restart the agent so it picks up the camera, then open the map. Your sensor appears with wavefronts collapsing into it, and starts recording every aircraft that passes — heard or not. The level meter on the setup page moves whenever there is sound, which is the quickest way to confirm the microphone is really reaching it.",
    link: { href: "/", label: "Open the map" },
    expect: "A dot where your camera is, labelled listening, and a rising count of aircraft.",
    stuck: [
      { problem: "The sensor does not appear.", fix: "The agent uploads every 10 seconds, but only once it has something to say. Near an airport give it a few minutes; elsewhere longer." },
      { problem: "It says no sound arriving.", fix: "The camera streams audio but the agent is not receiving it. Restart the agent; if it persists, re-run Test this camera." },
    ],
  },
];

const LEAVES = [
  "When a sound started and how long it lasted",
  "How loud it was against the background, and its frequency shape",
  "Which aircraft matched it, if any",
  "Your sensor position, rounded to about 110 metres",
];

const STAYS = [
  "Your camera's address, username and password",
  "Video — none is ever read, only the audio track",
  "Audio recordings, unless you opt in per clip",
  "Your exact coordinates",
];

function Where({ where }: { where: Where }) {
  const browser = where === "browser";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 text-[11px] ${
        browser ? "border-frost/30 text-frost" : "border-sodium/40 text-sodium"
      }`}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: browser ? "var(--frost)" : "var(--sodium)" }}
      />
      {browser ? "In your browser" : "On the camera machine"}
    </span>
  );
}

function StepBlock({ index, step }: { index: number; step: Step }) {
  return (
    <li className="grid gap-4 border-t border-edge py-9 md:grid-cols-[3rem_1fr]">
      <span className="font-mono text-[26px] leading-none text-slate-dim">
        {String(index + 1).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        <Where where={step.where} />
        <h3 className="mt-3 text-[18px] text-bone">{step.title}</h3>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-slate">{step.body}</p>

        {step.link && (
          <a
            href={step.link.href}
            className="mt-4 inline-block border border-sodium/50 px-3 py-1.5 text-[13px] text-sodium hover:bg-sodium/10"
          >
            {step.link.label}
          </a>
        )}

        {step.code && (
          <pre className="scroll-thin mt-4 overflow-x-auto border border-edge bg-night-deep p-4 font-mono text-[12.5px] leading-relaxed text-frost/90">
            {step.code}
          </pre>
        )}

        {step.expect && (
          <div className="mt-3 border-l-2 border-signal/50 pl-4">
            <p className="text-[12px] text-signal/90">What you should see</p>
            <pre className="scroll-thin mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-slate">
              {step.expect}
            </pre>
          </div>
        )}

        {step.stuck && (
          <dl className="mt-4 space-y-2">
            {step.stuck.map((s) => (
              <div key={s.problem} className="text-[12.5px] leading-relaxed">
                <dt className="text-slate-dim">{s.problem}</dt>
                <dd className="text-slate">{s.fix}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

export default function Join() {
  return (
    <main className="min-h-dvh bg-night-deep">
      <div className="mx-auto max-w-3xl px-6 py-16 md:px-10">
        <nav className="mb-14 flex items-center justify-between text-[13px]">
          <a href="/" className="text-slate hover:text-sodium">
            SkyEar
          </a>
          <a href="/devices" className="text-slate hover:text-sodium">
            Your sensors
          </a>
        </nav>

        <header>
          <h1 className="max-w-[20ch] text-[40px] leading-[1.08] tracking-tight text-bone md:text-[52px]">
            Your camera already hears aircraft. It just isn&rsquo;t listening.
          </h1>
          <p className="mt-6 max-w-[64ch] text-[16px] leading-relaxed text-slate">
            A security camera pointed at your garden has a microphone that picks up engines long
            before you notice them. SkyEar runs a small agent beside the camera, listens to that
            audio, and matches what it hears against live aircraft positions — so every detection
            checks itself. Enough fixed sensors across Lithuania and the same method starts to work
            for drones.
          </p>
          <p className="mt-4 text-[13px] text-slate-dim">
            About 15 minutes, most of it waiting for a download.
          </p>
        </header>

        {/* The single most common source of confusion, addressed before step 1. */}
        <section className="mt-14 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">
            You will be working in two places
          </h2>
          <div className="grid md:grid-cols-2">
            <div className="border-b border-edge p-6 md:border-b-0 md:border-r">
              <Where where="browser" />
              <p className="mt-3 text-[13px] leading-relaxed text-slate">
                Creating your account, generating a pairing code, and watching the map. Any device,
                anywhere.
              </p>
            </div>
            <div className="p-6">
              <Where where="machine" />
              <p className="mt-3 text-[13px] leading-relaxed text-slate">
                A NAS, a Raspberry Pi, or a spare computer on the same network as the camera. It has
                to reach the camera directly — that is the whole point, and it is why nothing on
                this site ever asks for your camera&rsquo;s password.
              </p>
            </div>
          </div>
          <p className="border-t border-edge px-6 py-4 text-[12px] leading-relaxed text-slate-dim">
            Every step below is tagged with which of the two it belongs to.
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-[15px] text-bone">Before you start</h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2 md:grid-cols-2">
            {[
              "A camera with a microphone, on your own network",
              "Its address, and a username and password for it",
              "A machine that stays on and can reach the camera — a NAS, a Pi, a spare computer",
              "Roughly how high the camera is mounted",
            ].map((item) => (
              <li key={item} className="text-[14px] leading-relaxed text-slate">
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">
            What to have ready for your camera
          </h2>

          <div className="border-b border-edge p-6">
            <p className="text-[13px] text-frost">Reolink, Hikvision, Dahua</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              Its address on your network, a username and a password. The setup page builds the
              rest and tests it before you commit. Make sure RTSP is switched on in the camera
              settings, usually under Network or Advanced.
            </p>
          </div>

          <div className="border-b border-edge p-6">
            <p className="text-[13px] text-sodium">Ubiquiti UniFi Protect</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              Different from the rest, so the form asks for different things. The stream comes from
              your <strong className="font-normal text-bone">NVR or UDM</strong>, not the camera,
              and there is no username or password — a token in the URL is the credential.
            </p>
            <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              In Protect, open the camera → Settings → Advanced → enable{" "}
              <strong className="font-normal text-bone">RTSP</strong> for any one quality. Copy the
              URL it shows and keep the part after the last slash:
            </p>
            <pre className="scroll-thin mt-3 overflow-x-auto border border-edge bg-night-deep p-4 font-mono text-[12.5px] leading-relaxed text-frost/90">
{`rtsps://192.168.1.1:7441/aBcDeF123456?enableSrtp
                         └── paste this part ──┘`}
            </pre>
            <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-slate-dim">
              Protect issues a new token if you turn RTSP off and on again, which silently stops
              the stream until you paste the new one.
            </p>
          </div>

          <div className="p-6">
            <p className="text-[13px] text-frost">Does it even have a microphone?</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              Many cameras do not, and the box rarely says. You do not need to find out in advance —
              the setup page tests the stream and tells you plainly whether there is audio on it.
            </p>
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-[15px] text-bone">First, install the agent</h2>
          <p className="mt-2 max-w-[64ch] text-[14px] leading-relaxed text-slate">
            It runs on a machine that can reach your camera over the local network and stays on.
            Pick where yours is going.
          </p>
          <div className="mt-6">
            <SetupChooser />
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-[15px] text-bone">Then, the same four steps everywhere</h2>
          <p className="mt-2 max-w-[64ch] text-[14px] leading-relaxed text-slate">
            Note the order: your camera is tested before you are asked for an email. If it turns
            out to have no microphone, you will not have signed up for anything.
          </p>
          <ol className="mt-2">
            {STEPS.map((step, i) => (
              <StepBlock key={step.title} index={i} step={step} />
            ))}
          </ol>
        </section>

        {/*
          People ask this immediately, and the honest answer has a caveat that
          matters more than the instructions. A speaker at two metres arrives
          with every harmonic intact; the same aircraft at three kilometres
          arrives with the top of its spectrum absorbed by the air. Measured
          here: a real piston aircraft scored 0.07 on the periodicity feature
          that synthetic engine sound scored 0.23 on. So a speaker test proves
          the chain works, and proves nothing about detection range.
        */}
        <section className="mt-6 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">
            Testing it with a speaker
          </h2>
          <div className="p-6">
            <p className="max-w-[64ch] text-[14px] leading-relaxed text-slate">
              Play a recording of an aircraft or a drone through a phone or speaker near the
              camera, at normal listening volume, for at least fifteen seconds — a short burst is
              filtered out as a click. Keep the setup page open: the level meter should rise while
              it plays, and within a minute or two the sound appears on the map as an{" "}
              <span className="text-sodium">unexplained sound</span>, because nothing with a
              transponder was overhead.
            </p>
            <p className="mt-4 max-w-[64ch] text-[14px] leading-relaxed text-slate">
              That is a real test of one thing: audio is reaching the detector, the detector fires,
              the event uploads, and the map draws it. It is the fastest way to confirm a new
              sensor end to end.
            </p>
            <p className="mt-4 max-w-[64ch] text-[14px] leading-relaxed text-slate-dim">
              It is not a test of whether SkyEar can hear a drone. A speaker two metres away
              delivers the whole spectrum; three kilometres of air removes the upper harmonics and
              a propeller smears what is left. Measured at this site, a real light aircraft scored
              a third of the periodicity a synthesised one did. Anything tuned against a speaker
              would be tuned against the wrong signal — so treat the result as &ldquo;the wiring
              works&rdquo;, and nothing more.
            </p>
          </div>
        </section>

        <section className="mt-6 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">
            What crosses your network boundary
          </h2>
          <div className="grid md:grid-cols-2">
            <div className="border-b border-edge p-6 md:border-b-0 md:border-r">
              <p className="text-[13px] text-sodium">Sent to SkyEar</p>
              <ul className="mt-3 space-y-2">
                {LEAVES.map((item) => (
                  <li key={item} className="text-[13px] leading-relaxed text-slate">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-6">
              <p className="text-[13px] text-frost">Never leaves your machine</p>
              <ul className="mt-3 space-y-2">
                {STAYS.map((item) => (
                  <li key={item} className="text-[13px] leading-relaxed text-slate">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="border-t border-edge px-6 py-4 text-[12px] leading-relaxed text-slate-dim">
            This is architectural, not a policy promise. The agent runs inside your network and
            pushes events out; nothing reaches in. There is no field anywhere on this site that asks
            for a camera address or password, because the servers could not use one — they cannot
            route to a private address, and a credential store an operator can decrypt is a target
            worth attacking.
          </p>
        </section>

        <section className="mt-10 border border-edge p-6">
          <h2 className="text-[15px] text-bone">Where this actually stands</h2>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-slate">
            Early, and measured rather than claimed. A single sensor near Vilnius airport currently
            hears a minority of the aircraft that pass it, and wind produces sounds loud enough to
            be mistaken for one. The map shows the detection rate next to the share of time
            background noise is present, so you can see for yourself whether a result means
            anything yet.
          </p>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-slate">
            Running a sensor helps most by producing honest negatives: every aircraft that passes
            and is <em>not</em> heard is recorded too. That is what tells us the real range of this
            method, and it is the data a classifier will eventually be trained on.
          </p>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-slate-dim">
            SkyEar does not send alerts, and will not until the Fire and Rescue Department and the
            military have had a say in how that should work.
          </p>
        </section>

        <section className="mt-12 flex flex-wrap items-center gap-4 border-t border-edge pt-8">
          <a
            href="/login"
            className="bg-sodium px-4 py-2 text-[14px] font-medium text-night-deep hover:bg-sodium/90"
          >
            Start with step one
          </a>
          <a href="/" className="text-[14px] text-slate hover:text-sodium">
            See what the network is hearing
          </a>
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-6 text-[12px] leading-relaxed text-slate-dim">
          <span className="max-w-[58ch]">
            Aircraft positions come from ADS-B, which is how each detection is checked
            automatically. Sensor positions are shown on the public map rounded to about a
            kilometre.
          </span>
          <a
            href="https://github.com/MrUnluckyy/skyear"
            className="whitespace-nowrap text-slate hover:text-sodium"
          >
            Source on GitHub
          </a>
        </footer>
      </div>
    </main>
  );
}

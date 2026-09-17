import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Become a sensor · SkyEar",
  description:
    "Step-by-step setup for turning a security camera you already own into an acoustic sensor for aircraft over Lithuania.",
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
    title: "Create your account",
    body: "Enter your email. You get a one-time link back — there is no password to choose. Click it and you land on your sensors page, where you will generate a pairing code in a moment.",
    link: { href: "/login", label: "Open the sign-in page" },
    expect: "A page titled Sensors, with your email under it and no devices listed yet.",
    stuck: [
      { problem: "No email after a minute.", fix: "Check spam. It is sent by Supabase on behalf of SkyEar." },
      { problem: "The link opens an error.", fix: "Links are single-use and expire. Request another." },
    ],
  },
  {
    where: "machine",
    title: "Start the agent next to your camera",
    body: "This runs on a machine that can reach your camera over the local network — a NAS, a Raspberry Pi, or any computer that stays on. It does not need to be powerful. It does need to stay awake, so a laptop is fine for trying it and poor for leaving it.",
    code: `# Synology: Container Manager → Project → Create → paste this, then Build
services:
  skyear:
    image: ghcr.io/mrunluckyy/skyear-agent:latest
    pull_policy: always
    container_name: skyear-agent
    restart: unless-stopped
    ports: ["8088:8088"]
    volumes: ["./data:/data"]

# Or, on any machine with a terminal. One line on purpose: pasted
# multi-line commands get split by some terminals and fail confusingly.
docker run -d --name skyear --restart unless-stopped --pull always -p 8088:8088 -v skyear-data:/data ghcr.io/mrunluckyy/skyear-agent:latest`,
    expect: `The container starts and its log says:

  setup page: http://192.168.1.144:8088
  no camera configured yet - open the setup page above to add one

That is expected. Nothing is configured yet.`,
    stuck: [
      { problem: "No Docker on the machine.", fix: "Synology: install Container Manager from Package Center. Linux or Raspberry Pi: curl -fsSL https://get.docker.com | sh" },
      { problem: "Port 8088 already used.", fix: "Change the first number, for example 9088:8088, and use that port below." },
      { problem: "\u201cThe container name /skyear is already in use.\u201d", fix: "An earlier attempt left one behind. Remove it with: docker rm -f skyear — then run the command again." },
      { problem: "\u201ccommand not found: ghcr.io\u201d", fix: "The command was split across lines by the terminal. Copy it as the single line above, with no line breaks." },
      { problem: "It restarts in a loop, and the log says FileNotFoundError: /config/config.yaml", fix: "An old image is cached locally. docker rm -f skyear, then run the command again - --pull always fetches the current one." },
    ],
  },
  {
    where: "browser",
    title: "Open the setup page and fill in one form",
    body: "Go to that machine's address with :8088 on the end — on a Synology, the same address you use for DSM. Everything else happens on one screen: pick your camera make, enter its address and password, press Test, set the position, and paste the pairing code from step one.",
    code: "http://YOUR-MACHINE-ADDRESS:8088",
    expect: `Test this camera reports something like:

  Audio found — aac at 16000 Hz. This camera can be a sensor.

Use my current location fills in the position, and the ground elevation is
looked up for you. Then Save and connect.`,
    stuck: [
      { problem: "\u201cThe camera rejected that username or password.\u201d", fix: "Reolink usually wants admin and the password you set in its app." },
      { problem: "\u201cCould not reach the camera.\u201d", fix: "Check the address, and that RTSP is switched on in the camera settings." },
      { problem: "\u201cThis camera streams video but no audio.\u201d", fix: "Some models have no microphone. That one cannot be a sensor." },
      { problem: "The page does not load at all.", fix: "The agent log prints the exact address to use. In Docker it may print the container address instead, so use the machine's own." },
    ],
  },
  {
    where: "browser",
    title: "Watch it start listening",
    body: "Restart the container so it picks up the camera, then open the map. Your sensor appears with wavefronts collapsing into it, and starts recording every aircraft that passes — heard or not.",
    link: { href: "/", label: "Open the map" },
    expect: "A dot where your camera is, labelled listening, and a rising count of aircraft. The level meter on the setup page moves whenever there is sound.",
    stuck: [
      { problem: "The sensor does not appear.", fix: "The agent uploads every 10 seconds but only once it has something to say. Near an airport give it a few minutes; elsewhere longer." },
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
          <h2 className="text-[15px] text-bone">Setting it up</h2>
          <ol className="mt-2">
            {STEPS.map((step, i) => (
              <StepBlock key={step.title} index={i} step={step} />
            ))}
          </ol>
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

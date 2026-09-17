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
    body: "Open the sign-in page and enter your email. You get a one-time link by email — there is no password to choose. Click the link and you land on your sensors page.",
    code: "https://skyear.app/login",
    expect: "After clicking the emailed link you see a page titled Sensors, with your email under it and no devices listed yet.",
    stuck: [
      {
        problem: "The email has not arrived after a minute.",
        fix: "Check spam. The sender is Supabase on behalf of SkyEar.",
      },
      {
        problem: "The link opens an error page.",
        fix: "Links expire and are single-use. Request a new one.",
      },
    ],
  },
  {
    where: "machine",
    title: "Open a terminal on the machine with the camera",
    body: "Everything from here runs on the computer that can reach your camera on the local network — your NAS over SSH, a Raspberry Pi, or a laptop on the same Wi-Fi. Not on a server somewhere, and not in your browser. This is the part people get wrong.",
    code: "ping -c 3 192.168.1.50   # your camera's address",
    expect: `64 bytes from 192.168.1.50: icmp_seq=0 ttl=64 time=3.1 ms
64 bytes from 192.168.1.50: icmp_seq=1 ttl=64 time=2.8 ms
3 packets transmitted, 3 packets received, 0.0% packet loss`,
    stuck: [
      {
        problem: "Synology: you need SSH first.",
        fix: "Control Panel → Terminal & SNMP → Enable SSH service, then ssh admin@your-nas from your own computer.",
      },
      {
        problem: "The camera does not respond.",
        fix: "Find its address in your router's device list, or in the camera's own app.",
      },
    ],
  },
  {
    where: "machine",
    title: "Install Docker if it is not already there",
    body: "The agent ships as a container so you do not have to install Python or ffmpeg yourself.",
    code: `# Synology: Package Center → install "Container Manager"
# Raspberry Pi or Linux:
curl -fsSL https://get.docker.com | sh

# Check it works
docker --version`,
    expect: "A version number, for example: Docker version 27.3.1",
  },
  {
    where: "machine",
    title: "Download the agent",
    body: "One folder holds everything: the config, your camera password, and a compose file that pulls the published image.",
    code: `git clone https://github.com/MrUnluckyy/skyear.git
cd skyear/agent`,
    expect: "Running ls shows docker-compose.yml, config.example.yaml and .env.example.",
    stuck: [
      {
        problem: "git is not installed.",
        fix: "Download the ZIP from the GitHub page instead and unpack it, then cd into skyear/agent.",
      },
    ],
  },
  {
    where: "machine",
    title: "Check your camera actually has a microphone",
    body: "Most security cameras carry audio on the sub-stream, but not all of them, and it is worth knowing before you go further. Replace USER, PASSWORD and the address with yours.",
    code: `docker run --rm linuxserver/ffmpeg:latest \\
  -v error -rtsp_transport tcp \\
  -i "rtsp://USER:PASSWORD@192.168.1.50:554/Preview_01_sub" \\
  -t 1 -f null -`,
    expect: "No error. If the camera has no audio track, the next step's --check will say so plainly.",
    stuck: [
      {
        problem: "401 Unauthorized.",
        fix: "Wrong username or password. Reolink cameras often use admin with the password you set in the app.",
      },
      {
        problem: "Connection refused or timeout.",
        fix: "RTSP may be disabled on the camera. Enable it in the camera's settings, usually under Network → Advanced.",
      },
    ],
  },
  {
    where: "machine",
    title: "Fill in your camera and where it is",
    body: "Copy the two template files and edit them. The position matters more than it looks: every distance and sound-delay figure is measured from it, so a few hundred metres of error shows up in all of them.",
    code: `cp config.example.yaml config.yaml
cp .env.example .env
nano config.yaml`,
    expect: `Set these, then save with Ctrl+O and exit with Ctrl+X:

  host: 192.168.1.50      your camera's address
  username: admin
  lat: 54.6872            where the camera physically is
  lon: 25.2797            right-click the spot in Google Maps to copy them
  elevation_m: 210        ground height above sea level there
  mount_height_m: 4       how far above the ground it is mounted

Then put the camera password in .env:  nano .env`,
    stuck: [
      {
        problem: "Which stream type do I pick?",
        fix: "reolink, hikvision, dahua and ubiquiti are handled directly. Anything else: set url_env and supply the whole URL.",
      },
    ],
  },
  {
    where: "machine",
    title: "Test before committing to it",
    body: "One command checks both halves: that the camera audio is reachable, and that live aircraft positions are arriving. It prints what it found and exits.",
    code: "docker compose run --rm skyear --check",
    expect: `[home-1] OK audio: stream|codec_name=aac|codec_type=audio|sample_rate=16000
[adsb] OK 6 aircraft within 15 nm
   BTI3TP    BCS3  alt   1067 m`,
    stuck: [
      {
        problem: "CAM1_PASSWORD is not set.",
        fix: "The password is missing from .env. Open it and set CAM1_PASSWORD=yourpassword.",
      },
      {
        problem: "FAIL with 401.",
        fix: "The password in .env is wrong. The agent never prints it back, so check the file directly.",
      },
      {
        problem: "adsb FAIL.",
        fix: "Usually a rate limit. Wait a minute and run it again.",
      },
    ],
  },
  {
    where: "browser",
    title: "Generate a pairing code",
    body: "Go to your sensors page and press Generate pairing code. A short code appears, along with the exact command to run, with the code already filled in.",
    code: "https://skyear.app/devices",
    expect: "An eight-character code such as K4M7PQR2, valid for 15 minutes and usable once.",
  },
  {
    where: "machine",
    title: "Pair the agent with your account",
    body: "Run this once, with your code. It links this machine to your account and stores a token that you can revoke at any time.",
    code: "docker compose run --rm skyear --pair K4M7PQR2",
    expect: `OK paired as device 1ecdcb15-fae1-4053-aed6-b380c3bea6e1
   cameras: home-1
   token stored in /data/device.json (never commit it)`,
    stuck: [
      {
        problem: "code invalid, expired, or already used.",
        fix: "Codes last 15 minutes and work once. Generate a fresh one.",
      },
      {
        problem: "already paired.",
        fix: "Delete data/device.json and pair again.",
      },
    ],
  },
  {
    where: "machine",
    title: "Leave it running",
    body: "Start the agent in the background. It restarts on its own if the machine reboots.",
    code: `docker compose up -d
docker logs -f skyear-agent`,
    expect: `SkyEar agent running with 1 camera(s)
audio flowing from rtsp://***@192.168.1.50:554/Preview_01_sub
[home-1] alive, noise floor -20.9 dB
[home-1] PASS BTI3TP BCS3 closest 6.7 km alt 587 m -> not heard

Press Ctrl+C to stop watching the log. That does not stop the agent.`,
  },
  {
    where: "browser",
    title: "Confirm it arrived",
    body: "Open the map. Within about a minute your sensor appears with rings collapsing into it, and the panel starts counting passes.",
    code: "https://skyear.app",
    expect: "A dot where your camera is, labelled listening, and a rising count of aircraft under it.",
    stuck: [
      {
        problem: "The sensor does not appear.",
        fix: "The agent uploads every 30 seconds and only after it has recorded something. Give it a few minutes near an airport, longer elsewhere.",
      },
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
            About 30 minutes, most of it waiting for downloads.
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
              "A camera with a microphone, reachable over RTSP",
              "Its address, username and password",
              "A machine on the same network that can run Docker",
              "The camera's position and mounting height",
            ].map((item) => (
              <li key={item} className="text-[14px] leading-relaxed text-slate">
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">
            Find your camera&rsquo;s stream
          </h2>

          <div className="border-b border-edge p-6">
            <p className="text-[13px] text-frost">Reolink, Hikvision, Dahua</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              Handled directly. Give the agent the camera&rsquo;s address, a username and a
              password, and it builds the stream URL itself. Check RTSP is enabled on the camera,
              usually under Network or Advanced.
            </p>
          </div>

          {/* Genuinely different, and the difference trips people up. */}
          <div className="border-b border-edge p-6">
            <p className="text-[13px] text-sodium">Ubiquiti UniFi Protect</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              Works unlike the rest, so it gets its own path. The stream comes from your{" "}
              <strong className="font-normal text-bone">NVR or UDM</strong>, not the camera, over
              RTSPS on port 7441 — and there is no username or password. A per-camera token in the
              URL is the credential, which is why it goes in <code>.env</code> and never in{" "}
              <code>config.yaml</code>.
            </p>
            <ol className="mt-3 max-w-[62ch] space-y-1 text-[13px] leading-relaxed text-slate">
              <li>
                1. In UniFi Protect, open the camera → Settings → Advanced → enable{" "}
                <strong className="font-normal text-bone">RTSP</strong> for one quality. Low or
                Medium is plenty; the audio is the same on every quality.
              </li>
              <li>2. Copy the URL it shows you. It looks like the line below.</li>
              <li>3. Take the token — the part after the last slash — and put that in .env.</li>
            </ol>
            <pre className="scroll-thin mt-3 overflow-x-auto border border-edge bg-night-deep p-4 font-mono text-[12.5px] leading-relaxed text-frost/90">
{`rtsps://192.168.1.1:7441/aBcDeF123456?enableSrtp
                         └──── this is the token ────┘

# config.yaml
  - id: gate
    type: ubiquiti
    host: 192.168.1.1          # the NVR, not the camera
    password_env: CAM2_STREAM

# .env
CAM2_STREAM=aBcDeF123456`}
            </pre>
            <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-slate-dim">
              Protect regenerates the token if you disable and re-enable RTSP, so the stream stops
              until you paste the new one. The agent masks the token in its logs.
            </p>
          </div>

          <div className="p-6">
            <p className="text-[13px] text-frost">Anything else</p>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              If you can get a working RTSP URL out of the camera by any means, put the whole thing
              in <code>.env</code> and point <code>url_env</code> at it. The agent will use it
              verbatim.
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

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Become a sensor · SkyEar",
  description:
    "Turn a security camera you already own into an acoustic sensor for aircraft and drones over Lithuania.",
};

/** Setup genuinely is a sequence, so the steps are numbered. Nothing else is. */
const STEPS = [
  {
    title: "Get the agent",
    body: "Everything runs from one folder: the agent, a config file, and a compose file that pulls a published image. Nothing is built from source unless you want to change it.",
    code: `git clone https://github.com/MrUnluckyy/skyear.git
cd skyear/agent`,
    note: "The image ships for linux/amd64 and linux/arm64, so the same tag runs on a Synology and on a Raspberry Pi 4 or 5.",
  },
  {
    title: "Check your camera can hear",
    body: "Most security cameras carry a microphone on the sub-stream. This asks the camera what it streams and looks for an audio track. If you see codec_type=audio, you are in.",
    code: `ffprobe -v error -rtsp_transport tcp \\
  -show_entries stream=codec_type,codec_name,sample_rate \\
  -of compact \\
  "rtsp://USER:PASSWORD@CAMERA-IP:554/Preview_01_sub"`,
    note: "Reolink, Hikvision and Dahua are handled directly. Anything else works if you can give it an RTSP path.",
  },
  {
    title: "Point the agent at the camera",
    body: "Copy config.example.yaml to config.yaml and fill in four things: where the camera is, how high it sits, its address, and which environment variable holds its password.",
    code: `cameras:
  - id: home-1
    type: reolink          # or hikvision | dahua | generic
    host: 192.168.1.50
    username: admin
    password_env: CAM1_PASSWORD
    lat: 54.6872           # where the camera physically is
    lon: 25.2797
    elevation_m: 210       # ground height above sea level
    mount_height_m: 4`,
    note: "Put the password in .env, never in config.yaml. Both are gitignored.",
  },
  {
    title: "Test before you commit to it",
    body: "One command checks that the camera audio is reachable and that live aircraft positions are arriving. It prints what it found and exits.",
    code: `docker compose run --rm skyear --check

# or, running locally
.venv/bin/python -m skyear.main --config config.yaml --data ./out --check`,
    note: "Expect an audio stream at 16 kHz and a list of aircraft currently within 15 nautical miles.",
  },
  {
    title: "Pair with your account",
    body: "Sign in, generate a pairing code, and type it into the agent once. The agent trades the code for a device token that you can revoke at any time.",
    code: `docker compose run --rm skyear --pair YOURCODE`,
    note: "The code is single-use and expires in 15 minutes.",
  },
  {
    title: "Leave it listening",
    body: "Start the agent and let it run. It matches every sound against live aircraft positions and records whether each passing aircraft was heard or missed.",
    code: `docker compose up -d
docker logs -f skyear-agent`,
    note: "Runs on a Synology NAS, a Raspberry Pi 4 or 5, or any machine that can reach the camera.",
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

function Step({ index, step }: { index: number; step: (typeof STEPS)[number] }) {
  return (
    <li className="grid gap-4 border-t border-edge py-8 md:grid-cols-[3rem_1fr]">
      <span className="font-mono text-[28px] leading-none text-sodium/70">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h3 className="text-[17px] text-bone">{step.title}</h3>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-slate">{step.body}</p>
        <pre className="scroll-thin mt-4 overflow-x-auto border border-edge bg-night-deep p-4 font-mono text-[12px] leading-relaxed text-frost/90">
          {step.code}
        </pre>
        <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-slate-dim">{step.note}</p>
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
        </header>

        {/* The question anyone sensible asks first. */}
        <section className="mt-14 border border-edge">
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

        <section className="mt-16">
          <h2 className="text-[15px] text-bone">What you need</h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2 md:grid-cols-2">
            {[
              "A camera with a microphone, reachable over RTSP",
              "Somewhere to run it: a NAS, a Raspberry Pi, or a spare machine",
              "The camera's position and roughly how high it is mounted",
              "An outdoor microphone, ideally with a windscreen",
            ].map((item) => (
              <li key={item} className="text-[14px] leading-relaxed text-slate">
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16">
          <h2 className="text-[15px] text-bone">Setting it up</h2>
          <ol className="mt-2">
            {STEPS.map((step, i) => (
              <Step key={step.title} index={i} step={step} />
            ))}
          </ol>
        </section>

        {/* Overselling a civil-defence tool would be the wrong kind of wrong. */}
        <section className="mt-6 border border-edge p-6">
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
            href="/devices"
            className="bg-sodium px-4 py-2 text-[14px] font-medium text-night-deep hover:bg-sodium/90"
          >
            Generate a pairing code
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

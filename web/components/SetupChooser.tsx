"use client";

import { useState } from "react";

/**
 * Pick a platform, get only the instructions for it.
 *
 * The guide used to be one linear Docker path that assumed a NAS or a
 * terminal. Home Assistant was not mentioned once, despite a working add-on
 * existing - which is unfortunate, because HA users are the largest group of
 * people who already own a camera with a microphone and a machine that stays
 * on.
 *
 * Only installation genuinely differs between platforms. Everything after it
 * is the same, so the steps below the chooser are shared rather than
 * quadrupled - four near-identical guides is how documentation starts lying,
 * because only one of them gets updated.
 */

type Platform = {
  id: string;
  label: string;
  blurb: string;
  /** Where the setup page lives once the agent is running. */
  open: string;
  steps: { title: string; body: string; code?: string }[];
  note?: string;
};

const IMAGE = "ghcr.io/mrunluckyy/skyear-agent:latest";

const PLATFORMS: Platform[] = [
  {
    id: "ha",
    label: "Home Assistant",
    blurb: "Green, Yellow, a Pi, or a VM. Installs as an add-on with a sidebar panel.",
    open: "the SkyEar panel in your Home Assistant sidebar",
    steps: [
      {
        title: "Add the repository",
        body:
          "Settings → Add-ons → Add-on Store, then the three-dot menu at the top right → " +
          "Repositories. Paste this and press Add.",
        code: "https://github.com/MrUnluckyy/skyear-hassio",
      },
      {
        title: "Install the add-on",
        body:
          "Close the dialog and refresh the store. A SkyEar section appears at the bottom — " +
          "open it, press Install, and wait for the image to download. Turn on Start on boot " +
          "and Watchdog, then press Start.",
      },
      {
        title: "Open the panel",
        body:
          "SkyEar appears in the sidebar. There is no address to find and no port to open — " +
          "Home Assistant proxies it for you.",
      },
    ],
    note:
      "Requires a 64-bit system. There is no 32-bit ARM build because numpy publishes no " +
      "wheel for it, so a Raspberry Pi running 32-bit Raspberry Pi OS will not see the add-on.",
  },
  {
    id: "synology",
    label: "Synology NAS",
    blurb: "Container Manager. The most common setup for people who already run cameras.",
    open: "http://YOUR-NAS-ADDRESS:8088 — the same address you use for DSM",
    steps: [
      {
        title: "Install Container Manager",
        body: "Package Center → search for Container Manager → Install. Skip if you have it.",
      },
      {
        title: "Create a project",
        body:
          "Container Manager → Project → Create. Name it skyear, pick or make a folder, " +
          "choose Create docker-compose.yml, and paste this.",
        code: `services:
  skyear:
    image: ${IMAGE}
    pull_policy: always
    container_name: skyear-agent
    restart: unless-stopped
    ports: ["8088:8088"]
    volumes: ["./data:/data"]`,
      },
      {
        title: "Build it",
        body:
          "Press Next, then Done. The log shows the setup page address once it starts. " +
          "It will say no camera is configured yet — that is expected.",
      },
    ],
  },
  {
    id: "pi",
    label: "Raspberry Pi or Linux",
    blurb: "Any always-on box with a terminal. A Pi 4 is more than enough.",
    open: "http://YOUR-MACHINE-ADDRESS:8088",
    steps: [
      {
        title: "Install Docker, if it is not there",
        body: "One command, works on Raspberry Pi OS, Debian and Ubuntu.",
        code: "curl -fsSL https://get.docker.com | sh",
      },
      {
        title: "Run the agent",
        body:
          "One line on purpose. Pasted multi-line commands get split by some terminals and " +
          "fail with a confusing error about ghcr.io not being a command.",
        code: `docker run -d --name skyear --restart unless-stopped --pull always -p 8088:8088 -v skyear-data:/data ${IMAGE}`,
      },
      {
        title: "Find the address",
        body: "The log prints it. Or run hostname -I and use the first address with :8088.",
        code: "docker logs skyear",
      },
    ],
    note:
      "64-bit only. Raspberry Pi OS still ships 32-bit by default — check with getconf LONG_BIT, " +
      "which should print 64.",
  },
  {
    id: "desktop",
    label: "Mac or Windows",
    blurb: "For trying it out today. Not where you should leave it.",
    open: "http://localhost:8088",
    steps: [
      {
        title: "Install Docker Desktop",
        body: "From docker.com. Start it and wait for the whale icon to stop animating.",
      },
      {
        title: "Run the agent",
        body: "In Terminal on a Mac, or PowerShell on Windows. One line.",
        code: `docker run -d --name skyear --restart unless-stopped --pull always -p 8088:8088 -v skyear-data:/data ${IMAGE}`,
      },
    ],
    note:
      "A laptop is the wrong long-term home for a sensor, and more decisively than it sounds. " +
      "Measured on this project: a MacBook on battery is put to sleep by macOS roughly once an " +
      "hour whatever caffeinate is told to do, which cost 5.8 of 12 hours of recording in one " +
      "night. Keep it plugged in, or move to one of the options above once it works.",
  },
];

export default function SetupChooser() {
  const [active, setActive] = useState(PLATFORMS[0].id);
  const platform = PLATFORMS.find((p) => p.id === active) ?? PLATFORMS[0];

  return (
    <div>
      <div role="tablist" aria-label="Where you are installing" className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => {
          const on = p.id === active;
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={on}
              onClick={() => setActive(p.id)}
              className={`border px-3 py-2 text-left text-[13px] transition-colors ${
                on
                  ? "border-sodium bg-sodium/10 text-sodium"
                  : "border-edge text-slate hover:border-sodium/40 hover:text-bone"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-slate-dim">
        {platform.blurb}
      </p>

      <ol className="mt-6 space-y-6">
        {platform.steps.map((s, i) => (
          <li key={s.title} className="grid gap-3 md:grid-cols-[1.6rem_1fr]">
            <span className="font-mono text-[13px] leading-6 text-slate-dim">{i + 1}.</span>
            <div className="min-w-0">
              <h4 className="text-[15px] text-bone">{s.title}</h4>
              <p className="mt-1 max-w-[62ch] text-[14px] leading-relaxed text-slate">{s.body}</p>
              {s.code && (
                <pre className="scroll-thin mt-3 overflow-x-auto border border-edge bg-night-deep p-3.5 font-mono text-[12.5px] leading-relaxed text-frost/90">
                  {s.code}
                </pre>
              )}
            </div>
          </li>
        ))}
      </ol>

      {platform.note && (
        <p className="mt-6 border-l-2 border-sodium/50 pl-4 text-[13px] leading-relaxed text-slate">
          {platform.note}
        </p>
      )}

      <div className="mt-8 border-t border-edge pt-6">
        <p className="text-[13px] text-slate-dim">Then, on every platform:</p>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-slate">
          Open <span className="text-bone">{platform.open}</span>. Everything else happens on that
          one page — pick your camera make, enter its address and password, press Test, set the
          position, and connect.
        </p>
      </div>
    </div>
  );
}

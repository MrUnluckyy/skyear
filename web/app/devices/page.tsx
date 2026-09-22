"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import SiteNav from "@/components/SiteNav";

/** Unambiguous alphabet: no O/0, I/1, so a code read aloud is unambiguous. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const TTL_MINUTES = 15;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

type Device = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  last_seen_at: string | null;
};
type Code = { code: string; expires_at: string; used_at: string | null };
type Sensor = {
  id: string;
  device_id: string;
  camera_id: string;
  label: string | null;
  retired_at: string | null;
};

const MAX_LABEL = 40;

function countdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One live code, with the two things you do with it: read it, or copy it.
 *
 * The time left is counted down rather than printed as a clock time. "Expires
 * 14:32" asks you to work out whether that has happened yet; "4:18 left" does
 * not, and it is the only number on this page that changes while you look at
 * it - which is also the warning that it will run out.
 */
function LiveCode({ code, expiresAt, now }: { code: string; expiresAt: string; now: number }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright. The code is on screen in a
      // face chosen so it can be read off it, so this is not a dead end.
      setCopied(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-sodium/40 bg-sodium/5 px-4 py-3">
      <code className="font-mono text-[22px] tracking-[0.22em] text-sodium">{code}</code>
      <button
        onClick={copy}
        className="border border-edge px-2.5 py-1 text-[12px] text-slate hover:border-sodium/50 hover:text-sodium"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="ml-auto text-[12px] text-slate-dim">
        <span className="font-mono text-slate">{countdown(new Date(expiresAt).getTime() - now)}</span>{" "}
        left
      </span>
    </li>
  );
}

/**
 * Naming one sensor.
 *
 * The name is published on the public map, next to a position rounded to about
 * a kilometre. "The shed" is harmless; "Justas, Vilnius" is an address and a
 * person. The field says so rather than relying on people to think of it.
 */
function SensorName({
  sensor,
  onSave,
  onRetire,
}: {
  sensor: Sensor;
  onSave: (id: string, label: string | null) => Promise<string | null>;
  onRetire: (id: string, retired: boolean) => Promise<string | null>;
}) {
  const [value, setValue] = useState(sensor.label ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const dirty = value.trim() !== (sensor.label ?? "");

  async function save() {
    setState("saving");
    const err = await onSave(sensor.id, value.trim() || null);
    setMessage(err);
    setState(err ? "error" : "saved");
  }

  const retired = Boolean(sensor.retired_at);

  return (
    <li className={`py-2.5 ${retired ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          disabled={retired}
          value={value}
          maxLength={MAX_LABEL}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) save();
          }}
          placeholder="Name this sensor"
          aria-label={`Name for camera ${sensor.camera_id}`}
          className="min-w-0 flex-1 border border-edge bg-night-deep px-2.5 py-1.5 text-[13.5px] text-bone placeholder:text-slate-dim focus:border-sodium/60 focus:outline-none"
        />
        <button
          onClick={save}
          disabled={!dirty || state === "saving" || retired}
          className="border border-edge px-2.5 py-1.5 text-[12px] text-slate hover:border-sodium/50 hover:text-sodium disabled:opacity-40"
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          onClick={async () => {
            setState("saving");
            const err = await onRetire(sensor.id, !retired);
            setMessage(err);
            setState(err ? "error" : "idle");
          }}
          className="border border-edge px-2.5 py-1.5 text-[12px] text-slate-dim hover:border-sodium/50 hover:text-sodium"
        >
          {retired ? "Put back on the map" : "Remove from map"}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-slate-dim">
        camera <code className="font-mono text-slate">{sensor.camera_id}</code>
        {retired && <span className="ml-2 text-sodium">off the map, history kept</span>}
        {state === "saved" && <span className="ml-2 text-signal">saved</span>}
        {state === "error" && <span className="ml-2 text-bad">{message}</span>}
      </p>
    </li>
  );
}

export default function Devices() {
  // Memoised so `load` keeps one identity. Without it every render produced a
  // new client, a new callback, and a torn-down and rebuilt poll interval.
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data: user } = await supabase.auth.getUser();
    setEmail(user.user?.email ?? null);
    if (!user.user) return;
    const [d, se, c] = await Promise.all([
      supabase.from("devices").select("id,name,status,created_at,last_seen_at").order("created_at"),
      // RLS scopes this to the caller's own devices, so no filter is needed.
      supabase.from("sensors").select("id,device_id,camera_id,label,retired_at").order("created_at"),
      supabase.from("pairing_codes").select("code,expires_at,used_at").order("created_at", { ascending: false }).limit(5),
    ]);
    if (d.error) setError(d.error.message);
    setDevices((d.data as Device[]) ?? []);
    setSensors((se.data as Sensor[]) ?? []);
    setCodes((c.data as Code[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * Keep the page live while it is being watched.
   *
   * This used to fetch once on mount and never again, which is exactly wrong
   * for the moment it is used in: the setup flow ends with "restart the agent
   * and it appears here", so people sit on this page waiting for a sensor to
   * show up that the page had already decided did not exist. It also prints
   * "last seen", a value that was going stale as they read it.
   *
   * Ten seconds matches the agent's upload interval, which is also its
   * liveness heartbeat, so nothing is gained by asking faster. Only while the
   * tab is visible - a forgotten tab should not poll all night.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const live = codes.filter((c) => !c.used_at && new Date(c.expires_at).getTime() > now);

  /**
   * Tick only while a code is counting down.
   *
   * The clock exists to show a code running out, so it has no business
   * re-rendering the page every second on an account that is just renaming a
   * sensor.
   */
  useEffect(() => {
    const pending = codes.some((c) => !c.used_at && new Date(c.expires_at).getTime() > Date.now());
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [codes]);

  async function saveLabel(id: string, label: string | null): Promise<string | null> {
    const { error } = await supabase.from("sensors").update({ label }).eq("id", id);
    if (error) return error.message;
    setSensors((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)));
    return null;
  }

  /**
   * Retirement rather than deletion.
   *
   * Every foreign key cascades, so deleting a sensor deletes its detections
   * and passes with it. The value this project produces is the record of what
   * was *not* heard, and a tidy-up button should not be able to discard days
   * of it. Retiring hides the row everywhere public and keeps the history.
   */
  async function retireSensor(id: string, retired: boolean): Promise<string | null> {
    const { error } = await supabase
      .from("sensors")
      .update({ retired_at: retired ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) return error.message;
    setSensors((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, retired_at: retired ? new Date().toISOString() : null } : s
      )
    );
    return null;
  }

  /**
   * Retiring a device also revokes it: ingest rejects any device whose status
   * is not active, so the agent stops being accepted the moment this is set.
   */
  async function retireDevice(id: string, retired: boolean) {
    setError(null);
    const { error } = await supabase
      .from("devices")
      .update({ status: retired ? "retired" : "active" })
      .eq("id", id);
    if (error) return setError(error.message);
    await load();
  }

  /** Permanent, and it takes every measurement with it. */
  async function deleteDevice(id: string) {
    setError(null);
    const { error } = await supabase.from("devices").delete().eq("id", id);
    if (error) return setError(error.message);
    setConfirmDelete(null);
    await load();
  }

  async function createCode() {
    setBusy(true);
    setError(null);
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }
    const { error } = await supabase.from("pairing_codes").insert({
      code: newCode(),
      owner_id: user.user.id,
      expires_at: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
    });
    if (error) setError(error.message);
    await load();
    setBusy(false);
  }

  if (!email) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-night-deep px-6 text-[14px] text-slate">
        <p>
          Not signed in.{" "}
          <a href="/login" className="text-sodium hover:underline">
            Sign in
          </a>{" "}
          to pair a sensor.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-night-deep px-6 py-12 text-bone">
      <div className="mx-auto max-w-3xl">
        <SiteNav current="/devices" />

        <header className="mt-8">
          <h1 className="text-[30px] leading-tight tracking-tight">Your sensors</h1>
          <p className="mt-2 text-[13px] text-slate-dim">{email}</p>
        </header>

        {/*
          This block used to print two terminal commands, one of which began
          `cd ~/Sites/dronar/agent` - a path on the author's laptop. Pairing
          from a terminal still works and is documented for unattended
          installs, but it has not been the way anybody sets a sensor up since
          the agent grew a setup page. What belongs here is the code itself.
        */}
        <section className="mt-10 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">Pairing code</h2>
          <div className="p-6">
            <p className="max-w-[62ch] text-[14px] leading-relaxed text-slate">
              Generate a code here, then paste it into the setup page of the agent running beside
              your camera. That is the whole connection: the code is the only thing you carry from
              this browser to that machine.
            </p>

            <button
              onClick={createCode}
              disabled={busy}
              className="mt-5 bg-sodium px-4 py-2 text-[14px] font-medium text-night-deep hover:bg-sodium/90 disabled:opacity-50"
            >
              {busy ? "Generating…" : "Generate pairing code"}
            </button>

            {live.length > 0 && (
              <ul className="mt-5 space-y-2">
                {live.map((c) => (
                  <LiveCode key={c.code} code={c.code} expiresAt={c.expires_at} now={now} />
                ))}
              </ul>
            )}

            <p className="mt-5 max-w-[62ch] text-[13px] leading-relaxed text-slate">
              One code pairs one device, once, within {TTL_MINUTES} minutes. Adding a second sensor
              later, or reconnecting one you disconnected, needs a fresh code — generate another
              then.
            </p>
            <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-slate-dim">
              The code is the only thing SkyEar receives from you here. Your camera&rsquo;s address,
              username and password are typed into the agent on your own network and stay there.
            </p>
            <p className="mt-4 text-[13px]">
              <a href="/join" className="text-sodium hover:underline">
                Setup instructions
              </a>
            </p>
          </div>
        </section>

        <section className="mt-6 border border-edge">
          <h2 className="border-b border-edge px-6 py-4 text-[15px] text-bone">Paired agents</h2>
          <div className="p-6">
            <p className="max-w-[62ch] text-[14px] leading-relaxed text-slate">
              Names appear on the public map, beside a position rounded to about a kilometre. Pick
              something that describes the spot, not the person — &ldquo;the shed&rdquo;, not your
              name and street.
            </p>
            <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-slate-dim">
              <span className="text-slate">Remove from map</span> hides a camera and keeps
              everything it recorded — including the aircraft it did not hear, which is the part
              that makes the data worth anything.{" "}
              <span className="text-slate">Disconnect</span> stops an agent being accepted at all.
              Only <span className="text-slate">Delete permanently</span> destroys measurements, and
              it cannot be undone.
            </p>

            {devices.length === 0 ? (
              <p className="mt-5 max-w-[62ch] text-[13.5px] leading-relaxed text-slate-dim">
                No agents yet. Generate a code above, paste it into the agent&rsquo;s setup page,
                and it will appear here once it checks in.
              </p>
            ) : (
              <ul className="mt-5 divide-y divide-edge/60">
                {devices.map((d) => {
                  const mine = sensors.filter((s) => s.device_id === d.id);
                  const active = d.status === "active";
                  return (
                    <li key={d.id} className="py-4 text-[14px] first:pt-0">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-bone">{d.name}</p>
                          <p className="mt-0.5 text-[12px] text-slate-dim">
                            {d.last_seen_at
                              ? `last seen ${new Date(d.last_seen_at).toLocaleString()}`
                              : "never seen"}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 border px-2 py-0.5 text-[11px] ${
                            active
                              ? "border-signal/40 text-signal"
                              : "border-edge text-slate-dim"
                          }`}
                        >
                          {d.status}
                        </span>
                      </div>

                      {mine.length > 0 && (
                        <ul className="mt-3 divide-y divide-edge/60 border-t border-edge/60">
                          {mine.map((s) => (
                            <SensorName
                              key={s.id}
                              sensor={s}
                              onSave={saveLabel}
                              onRetire={retireSensor}
                            />
                          ))}
                        </ul>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-edge/60 pt-3">
                        <button
                          onClick={() => retireDevice(d.id, active)}
                          className="text-[12px] text-slate hover:text-sodium"
                        >
                          {active ? "Disconnect this agent" : "Reconnect this agent"}
                        </button>
                        {confirmDelete === d.id ? (
                          <span className="flex flex-wrap items-center gap-3 text-[12px]">
                            <span className="text-bad">
                              Delete {d.name} and every measurement it made?
                            </span>
                            <button
                              onClick={() => deleteDevice(d.id)}
                              className="border border-bad/50 px-2 py-1 text-bad hover:bg-bad/10"
                            >
                              Delete permanently
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-slate hover:text-bone"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(d.id)}
                            className="text-[12px] text-slate-dim hover:text-bad"
                          >
                            Delete permanently
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {error && <p className="mt-6 text-[13.5px] text-bad">{error}</p>}
      </div>
    </main>
  );
}

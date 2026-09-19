"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

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
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500/60 focus:outline-none"
        />
        <button
          onClick={save}
          disabled={!dirty || state === "saving" || retired}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-neutral-300 hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40"
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
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-neutral-400 hover:border-amber-500/50 hover:text-amber-300"
        >
          {retired ? "Put back on the map" : "Remove from map"}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        camera <code className="text-neutral-400">{sensor.camera_id}</code>
        {retired && <span className="ml-2 text-amber-400">off the map · history kept</span>}
        {state === "saved" && <span className="ml-2 text-emerald-400">saved</span>}
        {state === "error" && <span className="ml-2 text-red-400">{message}</span>}
      </p>
    </li>
  );
}

export default function Devices() {
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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

  // Unused codes only; the snippets below embed the newest one so there is
  // nothing to retype.
  const live = codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());

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
      <main className="flex min-h-dvh items-center justify-center bg-neutral-950 text-sm text-neutral-400">
        <p>
          Not signed in.{" "}
          <a href="/login" className="text-sky-400 underline">
            Sign in
          </a>{" "}
          to pair a sensor.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sensors</h1>
            <p className="text-sm text-neutral-400">{email}</p>
          </div>
          <nav className="flex gap-4 text-sm">
            <a href="/join" className="text-slate hover:text-sodium">
              Setup guide
            </a>
            <a href="/" className="text-slate hover:text-sodium">
              Map
            </a>
          </nav>
        </header>

        <section className="rounded-xl border border-white/10 bg-neutral-900/70 p-5">
          <h2 className="text-sm font-semibold">Pair an agent</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Generate a code, then run this on the machine with the camera — the one
            holding the credentials, not this browser.
          </p>

          <p className="mt-3 text-xs font-medium text-neutral-400">Local install (venv)</p>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-neutral-950 p-3 text-xs text-neutral-300">
{`cd ~/Sites/dronar/agent
.venv/bin/python -m skyear.main --config config.yaml --data ./out --pair ${live[0]?.code ?? "CODE"}`}
          </pre>

          <p className="mt-3 text-xs font-medium text-neutral-400">Docker (Synology, Raspberry Pi)</p>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-neutral-950 p-3 text-xs text-neutral-300">
{`docker compose run --rm skyear --pair ${live[0]?.code ?? "CODE"}`}
          </pre>
          <p className="mt-2 text-xs text-neutral-500">
            Use <code className="text-neutral-400">python3</code> or the venv interpreter —
            plain <code className="text-neutral-400">python</code> does not exist on macOS. The code
            is single-use and expires in {TTL_MINUTES} minutes; your camera address and password
            never leave that machine.
          </p>

          <button
            onClick={createCode}
            disabled={busy}
            className="mt-4 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate pairing code"}
          </button>

          {live.length > 0 && (
            <ul className="mt-4 space-y-2">
              {live.map((c) => (
                <li
                  key={c.code}
                  className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2"
                >
                  <code className="font-mono text-lg tracking-[0.2em] text-emerald-300">{c.code}</code>
                  <span className="text-xs text-neutral-400">
                    expires {new Date(c.expires_at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-white/10 bg-neutral-900/70 p-5">
          <h2 className="text-sm font-semibold">Paired devices</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Names appear on the public map, beside a position rounded to about a kilometre. Pick
            something that describes the spot, not the person — &ldquo;the shed&rdquo;, not your
            name and street.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            <span className="text-neutral-400">Remove from map</span> hides a camera and keeps
            everything it recorded — including the aircraft it did not hear, which is the part
            that makes the data worth anything.{" "}
            <span className="text-neutral-400">Disconnect</span> stops an agent being accepted at
            all. Only <span className="text-neutral-400">Delete permanently</span> destroys
            measurements, and it cannot be undone.
          </p>
          {devices.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">None yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-white/5">
              {devices.map((d) => {
                const mine = sensors.filter((s) => s.device_id === d.id);
                return (
                  <li key={d.id} className="py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{d.name}</p>
                        <p className="text-xs text-neutral-500">
                          {d.last_seen_at
                            ? `last seen ${new Date(d.last_seen_at).toLocaleString()}`
                            : "never seen"}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          d.status === "active"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-neutral-700/50 text-neutral-400"
                        }`}
                      >
                        {d.status}
                      </span>
                    </div>

                    {mine.length > 0 && (
                      <ul className="mt-2 divide-y divide-white/5 border-t border-white/5">
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

                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/5 pt-3">
                      <button
                        onClick={() => retireDevice(d.id, d.status === "active")}
                        className="text-xs text-neutral-400 hover:text-amber-300"
                      >
                        {d.status === "active"
                          ? "Disconnect this agent"
                          : "Reconnect this agent"}
                      </button>
                      {confirmDelete === d.id ? (
                        <span className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-red-300">
                            Delete {d.name} and every measurement it made?
                          </span>
                          <button
                            onClick={() => deleteDevice(d.id)}
                            className="rounded border border-red-500/50 px-2 py-1 text-red-300 hover:bg-red-500/10"
                          >
                            Delete permanently
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-neutral-400 hover:text-neutral-200"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(d.id)}
                          className="text-xs text-neutral-600 hover:text-red-400"
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
        </section>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}

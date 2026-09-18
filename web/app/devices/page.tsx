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
type Sensor = { id: string; device_id: string; camera_id: string; label: string | null };

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
}: {
  sensor: Sensor;
  onSave: (id: string, label: string | null) => Promise<string | null>;
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

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
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
          disabled={!dirty || state === "saving"}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-neutral-300 hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40"
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        camera <code className="text-neutral-400">{sensor.camera_id}</code>
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

  const load = useCallback(async () => {
    const { data: user } = await supabase.auth.getUser();
    setEmail(user.user?.email ?? null);
    if (!user.user) return;
    const [d, se, c] = await Promise.all([
      supabase.from("devices").select("id,name,status,created_at,last_seen_at").order("created_at"),
      // RLS scopes this to the caller's own devices, so no filter is needed.
      supabase.from("sensors").select("id,device_id,camera_id,label").order("created_at"),
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
                          <SensorName key={s.id} sensor={s} onSave={saveLabel} />
                        ))}
                      </ul>
                    )}
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

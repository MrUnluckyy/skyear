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

export default function Devices() {
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data: user } = await supabase.auth.getUser();
    setEmail(user.user?.email ?? null);
    if (!user.user) return;
    const [d, c] = await Promise.all([
      supabase.from("devices").select("id,name,status,created_at,last_seen_at").order("created_at"),
      supabase.from("pairing_codes").select("code,expires_at,used_at").order("created_at", { ascending: false }).limit(5),
    ]);
    if (d.error) setError(d.error.message);
    setDevices((d.data as Device[]) ?? []);
    setCodes((c.data as Code[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

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

  const live = codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());

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
          <a href="/" className="text-sm text-sky-400 underline">
            Map
          </a>
        </header>

        <section className="rounded-xl border border-white/10 bg-neutral-900/70 p-5">
          <h2 className="text-sm font-semibold">Pair an agent</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Generate a code, then run this on the machine with the camera:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-neutral-950 p-3 text-xs text-neutral-300">
python -m skyear.main --config config.yaml --data ./out --pair CODE
          </pre>
          <p className="mt-2 text-xs text-neutral-500">
            The code is single-use and expires in {TTL_MINUTES} minutes. Your camera address and
            password never leave that machine.
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
          {devices.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">None yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-white/5">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2 text-sm">
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
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}

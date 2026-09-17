"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-950 p-6 text-neutral-100">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-neutral-900/80 p-6 shadow-xl">
        <h1 className="text-lg font-semibold tracking-tight">SkyEar</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Sign in to pair a sensor. We send a one-time link — no password.
        </p>

        {sent ? (
          <p className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
            Check <span className="font-medium">{email}</span> for a sign-in link.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}

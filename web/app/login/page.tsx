"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

/**
 * Sign-in by one-time link.
 *
 * The interesting part is the failure handling. A magic link that is never
 * sent looks exactly like one that is - "check your email" either way - and
 * the most likely reason for it not to arrive is a sender rate limit, which
 * arrives as a 429 nobody reads. So rate limiting is named explicitly, and
 * the resend control is disabled with a visible countdown rather than
 * letting someone hammer a button that is making things worse.
 */

/** Supabase's own per-address cooldown; asking sooner just returns an error. */
const RESEND_SECONDS = 60;

function friendly(message: string): { text: string; retry: boolean } {
  const m = message.toLowerCase();
  if (m.includes("rate limit") || m.includes("too many") || m.includes("429")) {
    return {
      text:
        "Too many sign-in emails have been sent recently. This is a limit on our side, not yours. " +
        "Wait a few minutes and try again — and if it keeps happening, tell us, because it means the " +
        "mail allowance needs raising.",
      retry: true,
    };
  }
  if (m.includes("invalid") && m.includes("email")) {
    return { text: "That address does not look right. Check for a typo.", retry: false };
  }
  if (m.includes("signups not allowed") || m.includes("disabled")) {
    return { text: "New sign-ups are closed at the moment.", retry: false };
  }
  return { text: message, retry: true };
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    if (error) {
      setError(friendly(error.message).text);
      return;
    }
    setSent(true);
    setCooldown(RESEND_SECONDS);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-night-deep p-6 text-bone">
      <div className="w-full max-w-sm border border-edge bg-night p-6">
        <h1 className="text-[17px] font-medium tracking-tight">SkyEar</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-slate">
          Sign in to put a sensor on the map. One-time link, no password.
        </p>

        {sent ? (
          <div className="mt-5 space-y-3">
            <div className="border-l-2 border-signal pl-3">
              <p className="text-[13px] text-bone">Link sent to {email}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-slate">
                It works once and expires in an hour. If it is not there in a minute, check spam —
                the first mail from a new sender often lands there.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => send(email)}
                disabled={cooldown > 0 || busy}
                className="border border-edge px-3 py-1.5 text-[12px] text-slate hover:border-sodium hover:text-sodium disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-slate"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : busy ? "Sending…" : "Resend"}
              </button>
              <button
                onClick={() => {
                  setSent(false);
                  setError(null);
                }}
                className="text-[12px] text-slate-dim hover:text-sodium"
              >
                Use a different address
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(email);
            }}
            className="mt-5 space-y-3"
          >
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border border-edge bg-night-deep px-3 py-2 text-[14px] text-bone outline-none placeholder:text-slate-dim focus:border-sodium"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-sodium px-3 py-2 text-[14px] font-medium text-night-deep hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-3 border-l-2 border-bad pl-3 text-[12px] leading-relaxed text-slate">
            {error}
          </p>
        )}

        {/*
          The account is not the point of entry and should not pretend to be.
          A camera with no microphone cannot be a sensor, and finding that out
          after handing over an email is the wrong order.
        */}
        <p className="mt-6 border-t border-edge pt-4 text-[12px] leading-relaxed text-slate-dim">
          You do not need an account to try it. The agent installs and tests your camera on its
          own — sign in only when you want the sensor on the map.{" "}
          <a href="/join" className="text-sodium hover:underline">
            Setup guide
          </a>
        </p>
      </div>
    </main>
  );
}

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Uses the publishable key, which is public by design - the
 * protection is RLS plus the public_* views, not key secrecy. Anonymous
 * visitors can only ever read coarsened sensor positions and non-noise
 * detections; drone detections are withheld for 30 minutes by the view itself.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local."
    );
  }
  return createBrowserClient(url, key);
}

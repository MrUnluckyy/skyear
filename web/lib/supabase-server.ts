import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Server-side client that reads the session from cookies. */
export async function createClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // called from a Server Component; middleware refreshes the session
          }
        },
      },
    }
  );
}

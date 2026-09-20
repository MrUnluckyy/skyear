import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Keeps the auth session fresh so server components see a signed-in user. */
export async function middleware(request: NextRequest) {
  // A magic link that lands on "/" with a code has been redirected to the Site
  // URL rather than to the emailRedirectTo the login page asked for - which is
  // what Supabase does when that address is missing from the redirect allow
  // list. The code is still valid, so hand it to the callback rather than
  // dropping the person on the map, signed out, with a code in the address bar.
  const code = request.nextUrl.searchParams.get("code");
  if (code && request.nextUrl.pathname === "/") {
    const callback = new URL("/auth/callback", request.url);
    callback.search = request.nextUrl.search;
    return NextResponse.redirect(callback);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)"],
};

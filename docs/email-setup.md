# Email: why it breaks, and what to configure

## The problem

Supabase's built-in email sender exists so a project works on day one. It is
not a mail service. It is rate limited to a handful of messages **per hour,
project-wide**, and it sends from a shared `supabase.io` address that has no
relationship to this domain.

Both matter the moment SkyEar is posted anywhere public:

- **The cap is hit silently.** Thirty people try to sign in within an hour;
  the first few get a link and the rest get nothing. They see "Check your
  email for a sign-in link" and then wait for an email that was never sent.
  No error reaches the browser and nothing obvious appears in the logs.
- **A shared sender lands in spam.** The address has no SPF or DKIM alignment
  with skyear.lt, and it is shared with every other project using the
  default. Its reputation is not yours and you cannot improve it.

Two accounts have ever signed up here, so this path has never carried load.

## What to configure

Only the account creation is yours to do — it needs a provider signup and
credentials, which should not pass through anyone else's hands.

### 1. Pick a sender

Any of these cover a launch on their free tier:

| Provider | Free tier | Notes |
|---|---|---|
| Resend | 3,000/month, 100/day | Simplest setup, good deliverability |
| Postmark | 100/month free, then paid | Best deliverability, strict about content |
| Amazon SES | 3,000/month free for 12 months | Cheapest at scale, slowest to approve |

Resend is the least work for this size of project.

### 2. Verify a sending domain

Do not send as `@gmail.com` or any address you do not control the DNS for —
it will fail DMARC and go straight to spam.

Add the DNS records the provider gives you. You need all three:

- **SPF** — says this provider may send for the domain
- **DKIM** — signs the message so it cannot be forged in transit
- **DMARC** — tells receivers what to do when the first two fail. Start with
  `v=DMARC1; p=none; rua=mailto:you@yourdomain` and tighten to `p=quarantine`
  once the reports are clean

Wait for the provider to show the domain verified before going further.

### 3. Point Supabase at it

Dashboard → **Project Settings → Authentication → SMTP Settings**. On some
dashboard versions this lives at **Authentication → Settings → SMTP** instead.

Enable custom SMTP and fill in the provider's values. For Resend:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` (or `587` for STARTTLS) |
| Username | `resend` — the literal word, not an email address |
| Password | the API key, the `re_…` string |
| Sender email | an address at the verified domain |
| Sender name | `SkyEar` |

**The API key is the SMTP password.** This is the step people get wrong,
because Resend calls it an API key everywhere else and the username is not
what you would guess.

Create the key with **sending access only**, not full access, and scope it to
the verified domain if the provider allows it.

**The key belongs in the Supabase dashboard and nowhere else.** Not in this
repo, not in `web/.env.local`, not in Vercel's environment. No part of the web
app sends mail - Supabase Auth does - so putting it anywhere else spreads the
secret without enabling anything.

Then Dashboard → **Authentication → Rate Limits** and raise the email limit.

This is a separate setting and it is the entire reason for the exercise. The
cap is **not** lifted when custom SMTP is enabled, so it is perfectly possible
to configure everything above correctly, send a successful test, and still have
most people get nothing on launch day.

### 4. Set the templates

Dashboard → **Authentication → Emails**. There are two to paste, not one:

| Template | File | Subject |
|---|---|---|
| Confirm signup | `supabase/email-templates/confirm-signup.html` | `Confirm your email for SkyEar` |
| Magic Link | `supabase/email-templates/magic-link.html` | `Your SkyEar sign-in link` |

**Confirm signup is the one new people actually receive.** The login page
calls `signInWithOtp`, which creates the account when the address is unknown,
and Supabase sends the signup confirmation rather than the magic link on that
first send. Setting only Magic Link leaves every first-time contributor with
the stock Supabase email.

### 5. Check the redirect allow list

Dashboard → **Authentication → URL Configuration**. The magic link returns to
`emailRedirectTo`, which the login page sets to `<origin>/auth/callback`. Both
of these need to be present or the link fails after a successful email.

When the callback address is missing from the list, Supabase does not error —
it quietly sends people to the Site URL instead, so the link lands on
`https://skyear.lt/?code=…`, the map loads signed out, and the code sits
unused in the address bar. `middleware.ts` now catches that case and forwards
the code to the callback, so sign-in works either way, but the allow list is
still the thing to fix:

- Site URL: `https://skyear.lt`
- Redirect URLs: `https://skyear.lt/auth/callback`
- Keep `https://skyear.vercel.app/auth/callback` too while that host still resolves,
  or a link opened from an older tab breaks

Add `http://localhost:3000/auth/callback` too if you sign in while developing.

## Verifying it worked

1. Sign in with an address on a different provider from your usual one —
   Gmail and Outlook filter differently, and testing only against your own
   inbox proves very little.
2. Check the raw headers for `spf=pass`, `dkim=pass`, `dmarc=pass`.
3. Send one to a fresh address and confirm it reaches the inbox rather than
   Promotions or Spam.
4. Request several in a row and confirm none are dropped.

`https://www.mail-tester.com` scores all of this in one go; send it a magic
link and read the report.

## What the app does about failures

The login page surfaces the rate-limit case explicitly rather than showing a
generic error, because the default failure is indistinguishable from success
from the user's side. See `web/app/login/page.tsx`.

# Email templates

Paste these into the Supabase dashboard under **Authentication → Emails**.
They are kept here so the wording is reviewable and versioned; the dashboard
is the only place they take effect.

| File | Template | Subject |
|---|---|---|
| `confirm-signup.html` | Confirm signup | `Confirm your email for SkyEar` |
| `magic-link.html` | Magic Link | `Your SkyEar sign-in link` |

Both are needed, and confirm-signup is the one that matters. The login page
calls `signInWithOtp`, which creates the account when the address is new — and
Supabase sends **Confirm signup**, not Magic Link, on that first send. Every
contributor therefore meets the project through that template, and only sees
Magic Link when they come back. Confirmed against `auth.users`: every row has
`confirmation_sent_at` set at creation.

The subject line is set in the dashboard next to the template. Not "Confirm
your email" or "Magic link" on their own — the address is unknown to the
recipient, so the subject has to say which service it is or it reads as
phishing.

See `../../docs/email-setup.md` for SMTP configuration, which is the part that
actually decides whether these arrive.

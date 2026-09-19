# Email templates

Paste these into the Supabase dashboard under **Authentication → Emails**.
They are kept here so the wording is reviewable and versioned; the dashboard
is the only place they take effect.

| File | Template |
|---|---|
| `magic-link.html` | Magic Link |

The subject line is set in the dashboard next to the template. Use:

    Your SkyEar sign-in link

Not "Confirm your email" or "Magic link" — the address is unknown to the
recipient, so the subject has to say which service it is or it reads as
phishing.

See `../../docs/email-setup.md` for SMTP configuration, which is the part that
actually decides whether these arrive.

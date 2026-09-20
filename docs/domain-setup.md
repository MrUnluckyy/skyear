# skyear.lt: every record, in one place

Three systems want DNS on this domain and they do not conflict, but they are
configured in three different dashboards. This is the whole list.

Add these at whoever you registered skyear.lt with — for a `.lt` that is
usually the registrar's own control panel.

## 1. The website (Vercel)

Both hostnames are already attached to the Vercel project. They need DNS:

| Type | Name | Value |
|---|---|---|
| A | `@` (or `skyear.lt`) | `76.76.21.21` |
| A | `www` | `76.76.21.21` |

As of 2026-09-20 the domain is registered at Hostinger and its zone is served
by Hostinger's parking nameservers (`helios.dns-parking.com`,
`aster.dns-parking.com`). The apex still answers `2.57.91.91`, which is
Hostinger's "Parked Domain name" page — so skyear.lt resolves and serves 200
while showing nothing of this project. Only the apex A record has to change:
`www` is already a `CNAME` to the apex and follows it. If hPanel shows the
domain attached to a Hostinger website or parking page, detach that first, or
it will keep rewriting the record.

Vercel checks continuously and issues the TLS certificate itself once the
records resolve. Nothing to click.

If your registrar's panel will not let you set an A record on the apex, the
alternative is to point the nameservers at `ns1.vercel-dns.com` and
`ns2.vercel-dns.com` and let Vercel host the zone — but then the mail records
below have to be created inside Vercel rather than at the registrar. Setting
two A records is less disruptive.

Check progress with:

    npx vercel domains inspect skyear.lt

## 2. Sending mail (Resend)

Resend generates these when you add the domain, and the DKIM value is unique
to your account — copy them from its dashboard rather than from here. The
shapes are:

| Type | Name | Purpose |
|---|---|---|
| MX | `send` | bounce handling for the sending subdomain |
| TXT | `send` | SPF, authorising Resend to send |
| TXT | `resend._domainkey` | DKIM public key |

Resend sends from a subdomain (`send.skyear.lt`) by design. It keeps the
reputation of transactional mail separate from anything you might later send
from the apex, and means these records cannot collide with normal mail for
skyear.lt if you ever add a mailbox.

### DMARC, which Resend does not create for you

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@skyear.lt` |

Start at `p=none`: it reports without rejecting anything, so a
misconfiguration costs you visibility rather than delivery. Once the reports
are clean for a week or two, tighten to `p=quarantine`.

## 3. Nothing for Supabase

The database and Edge Functions stay on their own hostname and do not need a
record here. What does need changing is two settings, once the domain
resolves:

- **Authentication → URL Configuration → Site URL**: `https://skyear.lt`
- **Redirect URLs**: add `https://skyear.lt/auth/callback`, and keep the
  `skyear.vercel.app` one while that host still works — otherwise a magic link
  opened from an older tab fails after being delivered successfully, which is
  a miserable thing to debug.
- **SMTP sender email**: an address at the verified domain, once Resend shows
  it verified. Not before: sending from an unverified domain fails DMARC and
  goes straight to spam.

## Order matters

1. Add the two A records. The site comes up on the new domain within minutes.
2. Add Resend's records. Wait for its dashboard to show **verified** — this
   can take anything from minutes to a few hours.
3. Only then set the sender address in Supabase and send a test.

Doing step 3 first is the common mistake. It fails in a way that looks like
Supabase is broken when the actual problem is DNS that has not propagated.

## Verifying

    dig +short skyear.lt A
    dig +short www.skyear.lt A
    dig +short send.skyear.lt TXT
    dig +short resend._domainkey.skyear.lt TXT
    dig +short _dmarc.skyear.lt TXT

Then send a magic link to an address at a provider you do not normally use,
and check the headers show `spf=pass`, `dkim=pass`, `dmarc=pass`.
`mail-tester.com` scores all of it in one go.

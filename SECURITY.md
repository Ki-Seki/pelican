# Security

Pelican runs Claude Code on your computer for whoever can reach it. Anyone who can use your Pelican
can read your sessions and have Claude run commands as you, so treat access to it like SSH access.

## What Pelican does to keep others out

- **It listens on `127.0.0.1` by default.** Only programs on your computer can reach it. It will not
  listen on another address without a password, unless you start it with `--no-auth` to say that
  something in front of it authenticates.
- **An optional password**, set on the computer itself with `pelican password` (never over the
  network). It is stored as a scrypt hash in `~/.config/pelican/auth.json`, readable only by you.
  Signing in sets a cookie signed with a secret that changes with the password, so changing or
  removing the password signs every browser out. Each address gets ten attempts per ten minutes.
- **Host names are checked without a password.** The server answers only to this computer's names,
  loopback and the names you configure, so a web page cannot rebind its own domain to `127.0.0.1`
  (DNS rebinding) and read your sessions through your browser.
- **Changes must come from Pelican's own page.** Requests that change something, and the
  WebSocket, are refused when their `Origin` is another site's, unless you allow it with
  `PELICAN_ALLOWED_ORIGINS`.

Pelican keeps no copies of your sessions: it reads Claude Code's transcripts where Claude Code
writes them. It stores uploads, push notification keys and subscriptions in
`~/.local/state/pelican`.

## Reporting a vulnerability

Please report it privately through
[GitHub's security advisories](https://github.com/Ki-Seki/pelican/security/advisories/new) rather
than in a public issue. You will get an answer within a few days.

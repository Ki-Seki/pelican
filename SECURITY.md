# Security

Pelican runs Claude Code on your computer for whoever can use it. Anyone who can use your Pelican
can read your sessions and have Claude run commands as you, so treat access to it like SSH access.

## What Pelican does to keep others out

- **Every browser signs in, also on this computer.** At first start Pelican makes a random access
  token, kept in `~/.config/pelican/token.json` (readable only by you), and prints a link with it,
  the way Jupyter does. Opening that link signs the browser in; `pelican token` prints it again and
  `pelican token --reset` replaces it, signing every browser out. Other accounts and programs on
  the computer, containers and VMs that can reach `127.0.0.1` included, get nowhere without it.
  The link is printed only on a terminal, never into a log (a service's output file), and is
  never put on a command line: on macOS `--open` hands it to the browser through a file only you
  can read; elsewhere `--open` opens the sign-in page.
- **The QR code in Settings** that opens Pelican on a phone carries a one-time code, good once and
  for two minutes; the page never sees the token or your password. (The QR code Pelican prints in
  the terminal when it listens beyond this computer carries the token itself, like the link.)
- **Or a password**, set on the computer itself with `pelican password` (never over the network),
  stored as a scrypt hash in `~/.config/pelican/auth.json`. While one is set, it replaces the token.
- **Sign-in cookies** are `HttpOnly` and `SameSite=Strict`, and signed with a secret that belongs
  to the token or the password: changing either signs every browser out. Failed sign-ins are
  limited to 10 per address and 30 in all every 10 minutes, counted before the check, so requests
  sent together cannot slip past. `X-Forwarded-For` is believed only with `PELICAN_TRUSTED_PROXY=1`,
  for a proxy on the same computer.
- **`--no-auth` turns signing in off**, for when something in front of Pelican already
  authenticates (a reverse proxy, a gateway). Pelican says so loudly when it listens beyond this
  computer that way. The demo (`--demo`) signs no one in, so it listens only on `127.0.0.1`
  unless you pass `--no-auth`, shows only its own made-up folders, and changes nothing.
- **Only Pelican's own page gets in.** Pelican's page marks every request with a header
  (`X-Pelican: 1`) that another site cannot add without asking first, and Pelican never says yes.
  Requests a browser says come from another site (`Sec-Fetch-Site`) are refused, reads included,
  and so are changes whose `Origin` is another site's, unless you allow it with
  `PELICAN_ALLOWED_ORIGINS`.
- **Host names are checked.** The server answers only to this computer's names and addresses,
  loopback, Tailscale names (`*.ts.net`) and the names you configure, so a web page cannot rebind
  its own domain to this computer (DNS rebinding).
- **No framing by other sites.** Only Pelican's own origin, and the origins in
  `PELICAN_FRAME_ANCESTORS`, may show Pelican in a frame, so no other page can lay its buttons over
  Pelican's and have you approve something. Approval buttons also ignore clicks for a moment after
  they appear and after the page comes back into view. Settings take web origins only: `*`,
  `null` and the like are refused at start, with a warning.
- **What Claude writes stays on the screen.** Images in a reply load only from Pelican itself;
  another site's image is a link you can open. Pages and visuals Claude makes render in a sandboxed
  frame with no access to Pelican, its cookies or its API, under a content policy, first in every
  page, that lets them load scripts, styles and fonts from the public CDNs (cdnjs, jsDelivr, unpkg,
  Google Fonts) and talk to no other server; WebRTC is taken away. A page whose scripts navigate
  its own frame, or open a frame inside it, can still reach the network from there (for example
  with WebRTC): what it can send is what the page itself holds. Uploaded files are served with no
  sniffing and no scripts, and anything but an image downloads.
- **Folders run nothing of their own until Claude has worked in them.** Listing a folder's slash
  commands or MCP servers starts Claude Code there; in a folder no session has run in (that very
  folder), it loads only your user settings, so a fresh clone's hooks and MCP servers do not start
  just because you looked, and git does not run there at all (a repository's config can name
  programs git starts on its own, filters among them). Where Claude has worked, git runs for the
  Changes panel with hooks, the file-system monitor, external diffs and text converters off, reads
  paths literally, refuses `..`, and shows nothing of a work tree outside the folder.

Pelican keeps no copies of your sessions: it reads Claude Code's transcripts where Claude Code
writes them. It stores uploads, push notification keys and subscriptions in
`~/.local/state/pelican`.

## Reporting a vulnerability

Please report it privately through
[GitHub's security advisories](https://github.com/Ki-Seki/pelican/security/advisories/new) rather
than in a public issue. You will get an answer within a few days.

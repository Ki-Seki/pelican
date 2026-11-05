# Security

Pelican runs Claude Code on your computer for whoever can use it. Anyone who can use your Pelican
can read your sessions and have Claude run commands as you, so treat access to it like SSH access.

## What Pelican does to keep others out

- **Every browser signs in, also on this computer.** At first start Pelican makes a random access
  token, kept in `~/.config/pelican/token.json` (readable only by you), and prints a link with it,
  the way Jupyter does. Opening that link signs the browser in; `pelican token` prints it again and
  `pelican token --reset` replaces it, signing every browser out at once (a running Pelican notices
  within a second). Other accounts and programs on the computer, containers and VMs that can reach
  `127.0.0.1` included, get nowhere without it. The link is printed only on a terminal, never into
  a log (a service's output file), and is never put on a command line: on macOS `--open` hands it
  to the browser through a file only you can read; elsewhere `--open` opens the sign-in page.
- **A phone signs in with a one-time code**, never the token: the QR codes of `pelican phone`, of
  the start banner and of Settings carry a code that works once and for two minutes, and a new
  token or password voids the codes made before it. `pelican phone` first checks that the address
  reaches this very Pelican, asking it only for its public sign-in state, so no code goes to an
  address that turns out to be another server's. The page never sees the token or your password.
- **Or a password**, set on the computer itself with `pelican password` (never over the network),
  stored as a scrypt hash in `~/.config/pelican/auth.json`. While one is set, it replaces the token.
- **Sign-in cookies** are `HttpOnly` and `SameSite=Strict`, and signed with a secret that belongs
  to the token or the password: changing either signs every browser out. A cookie in use is
  renewed, so a browser stays signed in until it goes 30 days unused. Failed sign-ins are limited
  to 10 per address and 30 in all every 10 minutes, counted before the check, so requests sent
  together cannot slip past. `X-Forwarded-For` is believed only with `PELICAN_TRUSTED_PROXY=1`,
  for a proxy on the same computer.
- **Notifications follow the sign-in.** Each device's push subscription is tied to the secret it
  signed in under: a new token or password stops notifications to every device, and signing out
  turns them off on that device first.
- **`--no-auth` turns signing in off**, for when something in front of Pelican already
  authenticates (a reverse proxy, a gateway). Pelican says so loudly when it listens beyond this
  computer that way. The demo (`--demo`) signs no one in, so it listens only on `127.0.0.1`
  unless you pass `--no-auth`, shows only its own made-up folders, and changes nothing.
- **Only Pelican's own page gets in.** Pelican's page marks every request with a header
  (`X-Pelican: 1`) that another site cannot add without asking first, and Pelican never says yes.
  Requests a browser says come from another site (`Sec-Fetch-Site`) are refused, reads included,
  and so are changes whose `Origin` is another site's, unless you allow it with
  `PELICAN_ALLOWED_ORIGINS` (or it is the address in `PELICAN_PUBLIC_URL`).
- **Host names are checked.** The server answers only to this computer's names and addresses,
  loopback, Tailscale names (`*.ts.net`) and the names you configure, so a web page cannot rebind
  its own domain to this computer (DNS rebinding).
- **The page runs only its own code.** Its content policy lets it load scripts only from Pelican
  and send requests only to Pelican, so even HTML that slipped into the page could neither run nor
  send anything.
- **No framing by other sites.** Only Pelican's own origin, and the origins in
  `PELICAN_FRAME_ANCESTORS`, may show Pelican in a frame, so no other page can lay its buttons over
  Pelican's and have you approve something. Approval buttons also ignore clicks for a moment after
  they appear and after the page comes back into view. Settings take web origins only: `*`,
  `null` and the like are refused at start, with a warning.
- **What Claude writes stays on the screen.** Images in a reply load only from Pelican itself;
  another site's image is a link you can open. Pages and visuals Claude makes show as still
  pictures, in a sandboxed frame where nothing runs, and only from tool calls that ran: a visual
  Claude merely wrote into its reply shows as text. Their scripts run only when you tap Run, in a
  frame of their own with no access to Pelican, its cookies or its API. Its content policy lets
  them load scripts, styles and fonts from the public CDNs (cdnjs, jsDelivr, unpkg, Google Fonts)
  and talk to no other server, and WebRTC is taken away. Still, a page whose scripts run can reach
  the network in ways no policy covers (WebRTC from a frame it opens, DNS lookups) and send what it
  shows, so run a page only as you would open it in your browser. Uploaded files are served with
  no sniffing and no scripts, and anything but an image downloads.
- **Folders run nothing of their own until you trust them.** A folder can bring programs: hooks,
  helper commands and environment variables in its Claude Code settings, servers in its
  `.mcp.json`, filters in its git config. Claude Code asks before it runs them in a terminal, but
  never in a session started through its SDK, so Pelican asks. Before Claude Code first starts in
  a folder nobody has trusted that brings any of these, Pelican lists them, read from the folder's
  files, and offers **Trust and start** or **Use my settings only**. With your settings only,
  Claude Code loads just your user settings, and git runs none of the repository's filters, its
  file-system monitor or its hooks folder.
  A folder is trusted when Claude Code's own record says so (its trust dialog, read and never
  written), when you trusted it in Pelican, when Pelican made it (a scratch folder), or when
  Claude Code has worked there before, unless you chose your settings only for it. Listing a
  folder's slash commands or MCP servers starts Claude Code with hooks off and, in a folder nobody
  trusted, from your home folder with your settings only; git does not run there at all. In a
  trusted folder, git runs for the Changes panel with hooks, the file-system monitor, external
  diffs and text converters off, reads paths literally, refuses `..`, and shows nothing of a work
  tree outside the folder.
- **What gets installed is what was tested.** The package ships `npm-shrinkwrap.json`, so npm
  installs the exact dependency tree CI tested, with integrity hashes, and the Agent SDK, with the
  Claude Code it bundles, is pinned to one version.
- **A service holds no secret.** `pelican service install` writes your `PATH` and Pelican's and
  Claude Code's settings into the launchd agent or systemd unit (readable only by you), never a
  variable whose name says it is a key, a token or a password; its log never holds the sign-in
  link.

Pelican keeps no copies of your sessions: it reads Claude Code's transcripts where Claude Code
writes them. It stores uploads, push notification keys and subscriptions, the folders you trusted
or kept to your settings, and a note of the running server in `~/.local/state/pelican`.

## Reporting a vulnerability

Please report it privately through
[GitHub's security advisories](https://github.com/Ki-Seki/pelican/security/advisories/new) rather
than in a public issue. You will get an answer within a few days.

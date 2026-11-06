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
  token or password voids the codes made before it. `pelican phone` talks only to the Pelican
  your account started, which the note it leaves in its state folder (readable only by you) names,
  and asks it for each code with a proof good for that one request and a minute, never a sign-in
  cookie: another account's program on Pelican's port gets nothing that signs anyone in. It also
  checks that the address reaches this very Pelican, asking it only for its public sign-in state,
  so no code goes to an address that turns out to be another server's. A start on a port another
  program holds fails, instead of saying Pelican runs. The page never sees the token or your
  password.
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
  turns them off on that device first. Allow and Deny on a notification send the request the page
  would, with its header, from its origin and under its sign-in, and do nothing for a request that
  was already answered. They are offered only for a command a notification shows whole, never on
  Claude's description of it: printable ASCII with one space between words, on one line, that fits
  two lines of the narrowest notification (a macOS banner beside the site's icon) in the widest
  letters, and on Android, whose pop-up shows one line of a notification beside the buttons, that
  one line, as a phone 360 dp wide shows it. Anything else opens the session.
- **A browser signed out keeps nothing to show.** Signing out forgets its drafts and asks the
  browser to drop what it keeps of Pelican, and the pictures of a conversation are checked with
  Pelican each time they are shown, so a signed-out browser gets none from its cache.
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
  another site's image is a link you can open. Export as Markdown writes it as that link too, and
  a reply's HTML as text, so a Markdown reader that opens the file loads nothing a reply names and
  shows no heading or turn the reply made up. Pages and visuals Claude makes show as still
  pictures, in a sandboxed frame where nothing runs, and only from tool calls that ran: a visual
  Claude merely wrote into its reply shows as text. A still picture keeps no frames, embeds, links
  or scripts, wherever they hide: a browser looks up a frame's host name before any policy stops
  it, and the lookup alone can carry data. Their scripts run only when you tap Run, in a frame of
  their own with no access to Pelican, its cookies or its API. Its content policy lets them load
  scripts, styles and fonts from the public CDNs (cdnjs, jsDelivr, unpkg, Google Fonts) and talk
  to no other server, and WebRTC is taken away. Still, a page whose scripts run can reach the
  network in ways no policy covers (WebRTC from a frame it opens, DNS lookups) and send what it
  shows, so run a page only as you would open it in your browser. Uploaded files are served with
  no sniffing and no scripts, and anything but an image downloads.
- **Folders run nothing of their own until you trust them.** A folder can bring programs: hooks,
  helper commands and environment variables in its Claude Code settings, servers in its
  `.mcp.json`, slash commands, skills and agents that run a shell or tools without asking, filters
  in its git config. Claude Code asks before it runs them in a terminal, but never in a session
  started through its SDK, so Pelican asks. Before Claude Code first starts in a folder nobody has
  trusted that brings any of these, Pelican lists them, read from the folder's files (the git
  config through `git config`, which starts nothing, with the files it includes), and offers
  **Trust and start** or **Use my settings only**. With your settings only, Claude Code loads just
  your user settings, and git runs none of the repository's filters, its file-system monitor or
  its hooks folder; a folder whose git config git cannot read in full does not start that way.
  A folder is trusted when Claude Code's own record says so (its trust dialog, read and never
  written), when you trusted it in Pelican, when Pelican made it (a scratch folder), or when
  Claude Code has worked there before, unless you chose your settings only for it. Listing a
  folder's slash commands or MCP servers starts Claude Code with hooks off and, in a folder nobody
  trusted, from your home folder with your settings only; git does not run there at all. In a
  trusted folder, git runs for the Changes panel with hooks, the file-system monitor, external
  diffs and text converters off, reads paths literally, refuses `..`, and shows nothing of a work
  tree outside the folder.
- **Files stay in their folder.** Changes and files reads only regular files inside the folder a
  request names (in the app, the session's), by a relative path without `..` whose real path,
  links followed, is still inside it. It does not hold a signed-in browser to its sessions'
  folders: whoever can use Pelican can name another folder, as they can run commands there. A download comes as an attachment, with no sniffing and the sandbox's content policy, so it
  never runs in Pelican's page. Search runs the ripgrep inside Claude Code's own binary, by its
  full path, with no config file, an empty environment, no git and no links followed (or a scan
  in Node where that is not there), within limits on files, lines, time and output. What a turn
  changed is read from Claude Code's transcript, not from git, so it shows in any folder. Show all
  on a long `!` command reads the file Claude Code saved its output in, by that file's name alone,
  never a path, from that session's own `tool-results` folder, or, for a record a branch copied,
  from that of the session its row says it came from, when the record's path names that session:
  a regular file reached through no link and with no other name (no hard link).
- **Only the files Claude sent are shown, and only as files.** In the sessions Pelican runs,
  Pelican tells Claude Code it shows the files Claude sends (`CLAUDE_CODE_ATTACHMENTS_BY_PATH`, set
  for Claude Code alone, never for a `!` command), which turns on SendUserFile and nothing else. In
  that mode Claude Code uploads nothing: it checks that each file exists and is a regular file,
  asks you first where its Read rules would (a file outside the session's folder), and records
  where the file is. It then leaves out what governs its uploads, your organization's "File upload"
  policy and its checks for a provider other than Anthropic's API and for
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; its own switch for the tool (`tengu_send_user_file`)
  and its brief mode still turn the tool off, and it sends no file to Remote Control viewers on
  claude.ai. Pelican serves a file of a session only at a path Claude Code recorded it delivered
  there, the absolute path it checked rather than the one Claude asked for (or, from Claude
  Desktop, the file an Artifact call published), and refuses any other path a request names; it
  says whether a file is still there only of the files Claude sent in that session. It reads the
  file as it is on disk when you look, read only, a regular file reached through no link that leads
  out of its folder, up to 200 MB, and sends no more of it than it said it would, however the file
  grows meanwhile (a download of one of the folder's files too). A picture shows as itself and text
  as text, inert; a video or a sound plays as itself, never sniffed, a part at a time, and in a tab of
  its own the browser's player may load it from Pelican but nothing runs (a sandbox that allows no
  scripts, and no other content); a page or an SVG is a still preview, as above; a PDF opens in the
  browser's own viewer, in a tab of its own, never sniffed or framed; anything else downloads. A
  file's name shows any character that hides or turns text around as ⟨U+…⟩, with a warning, on its
  card and in the name it is saved under, so a script cannot pass for a picture.
- **A workflow's files stay in its session's folder.** A workflow's card reads, for a run the
  session's own transcript launched, only its record, journal, script copy and its agents'
  transcripts and meta files, by the names Claude Code gives them and ids checked against their
  formats, each a regular file whose real path, links followed, is inside the session's own folder
  next to its transcript, and within a size. An Agent call's steps are read the same way, from its
  subagent's own transcript in that folder. An agent's steps come a page at a time, at most 768 KB
  of them (a message larger than 128 KB has its parts cut, saying how many were left out), and its
  pictures are left out.
- **A side chat only reads.** It runs with Read, Grep and Glob alone, no MCP servers, in Don't ask
  mode with every other request refused, takes no `/` or `!` commands, and stays that way whenever
  Pelican resumes it or a branch of it.
- **What gets installed is what was tested.** The package ships `npm-shrinkwrap.json`, so npm
  installs the exact dependency tree CI tested, with integrity hashes, and the Agent SDK, with the
  Claude Code it bundles, is pinned to one version.
- **A service holds no secret.** `pelican service install` writes your `PATH` and Pelican's and
  Claude Code's settings into the launchd agent or systemd unit, made readable only by you even
  when the file was there before. It never writes a variable whose name says it is a key, a token,
  a password or headers, nor an address with a user name or password in it; its log never holds
  the sign-in link.

Pelican keeps no copies of your sessions: it reads Claude Code's transcripts where Claude Code
writes them, and saves a `!` command's output too long for the conversation where Claude Code saves
one, in the session's `tool-results` folder, readable only by you. It stores uploads, push
notification keys and subscriptions, the folders you trusted or kept to your settings, which
sessions you pinned or archived (their ids), the usage figures it counted from the transcripts
(token counts, times, models and folders, no conversation text) with the sessions it ran and how
long they waited for you, and a note of the running server in `~/.local/state/pelican`. Its pins
and archive are its own: Claude Desktop's are neither read nor written.

## Reporting a vulnerability

Please report it privately through
[GitHub's security advisories](https://github.com/Ki-Seki/pelican/security/advisories/new) rather
than in a public issue. You will get an answer within a few days.

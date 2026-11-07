# Security

Pelican runs Claude Code on your computer for whoever can use it. Anyone who can use your Pelican
can read your sessions and have Claude run commands as you, so treat access to it like SSH access.

## What Pelican does to keep others out

- **Every browser signs in, also on this computer.** At first start Pelican makes a random access
  token, kept in `~/.config/pelican/token.json` (readable only by you), and prints a link with it,
  the way Jupyter does. Opening that link signs the browser in; `pelican token` prints it again and
  `pelican token --reset` replaces it, signing every browser out at once, the connections and
  terminals it has open included (a running Pelican notices within a second). Other accounts and
  programs on the computer, containers and VMs that can reach `127.0.0.1` included, get nowhere
  without it. The link is printed only on a terminal, never into a log (a service's output file),
  and is never put on a command line: on macOS `--open` hands it to the browser through a file only
  you can read; elsewhere `--open` opens the sign-in page.
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
  shows no heading or turn the reply made up. A reply's links by reference are written with their
  addresses and its footnotes under labels of its own, so no reply changes where another's links
  lead or what its footnotes say. Pages and visuals Claude makes show as still
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
  helper commands and environment variables in its Claude Code settings, servers in its `.mcp.json`,
  slash commands, skills and agents that run a shell or tools without asking, filters in its git
  config. Claude Code asks before it runs them in a terminal, but never in a session started through
  its SDK, so Pelican asks. Before Claude Code first starts in a folder nobody has trusted that
  brings any of these, Pelican lists them, read from the folder's files as Claude Code reads them
  (those of the folder and its parents up to the repository's top, and the `.mcp.json` of each
  folder above it but your home folder and those that hold it; a skill's `SKILL.md` in any case, as
  a Mac finds it, and commands and agents at any depth, a folder of them nested more than ten deep
  named as one the sheet shows part of; a settings file saved with a byte-order mark or as UTF-16
  too, and one it cannot read as JSON named as such; a skill's frontmatter broken into lines at a
  carriage return too; the git config through `git config`, which starts nothing, with the files it
  includes), each whole, its lines kept, a hook's arguments too (as much of a file and of a folder
  as any project brings, what it warns of and its own notes always kept, so no number of harmless
  items leaves one out, and what the repository's git config runs whatever the rest brings: past
  that, the sheet names above the list, in red, the first three files it shows part of and how many
  more, and the folder is asked about all the same), with what hides or turns text around written
  out as ⟨U+…⟩ and warned of, as an approval shows it, and offers **Trust and start** or **Use my
  settings only**. In a command a space other than a plain one is written out too, unless Pelican
  finds it in quotes, a heredoc's body or a comment, as bash, zsh, dash and macOS's bash 3.2 read
  the command and a script it hands a new shell in the ways Pelican follows (`bash -c`, `ssh`, a
  heredoc or a pipe into `sh`, a file it writes with a redirection or `tee` and runs by its path or,
  made a program, by its name, or that runs on its own as a git hook or a file a shell reads as it
  starts, and the like); quoted text with a substitution's start in it counts as in a word. A
  command that uses what can run text later in its own shell is one Pelican cannot tell, however the
  text is made (split across quotes, by a variable or an escape): `eval`, `source`, `trap`, an alias
  in any form, `read`, `declare`, `let`, `unset`, zsh's `set -A` and its `functions` array, bash's
  `BASH_ALIASES`, a parameter flag such as zsh's `(e)` and `$~x` or bash's `@P`, `setopt`, `test`
  with an operator a variable may give, a command whose name Pelican does not know, arithmetic on a
  variable the command sets to anything but a number, and the like, a command's name counting in any
  case (a Mac runs `READ` as /usr/bin/read); so is a script or a program run by a path that is not
  plain text, or from a folder the command writes into but for a file it wrote there. Where Pelican
  cannot tell, every such space is written out, and it cannot tell a command longer than 64 KB, or
  one whose reading would take more than a fixed budget of steps and memory: no command, nor a
  tool's input or a trust sheet's items, which share one, takes more time or memory than that to
  read. A file that another program writes by itself (`sed`'s `w`, `sort -o`, `split`, perl, python,
  awk) is not read as a script, nor is a string that a program runs in a shell of its own (python's
  `os.system`, `make`) followed. With your settings only, Claude Code loads just your user settings,
  and git runs none of the repository's filters, its file-system monitor or its hooks folder; a
  folder whose git config git cannot read in full does not start that way. A folder is trusted when
  Claude Code's own record says so (its trust dialog, read and never written), when you trusted it
  in Pelican, when Pelican made it (a scratch folder), or when Claude Code has worked there before,
  unless you chose your settings only for it. Listing a folder's slash commands or MCP servers
  starts Claude Code with hooks off and, in a folder nobody trusted, from your home folder with your
  settings only; git does not run there at all. In a trusted folder, git runs for the Changes panel
  with hooks, the file-system monitor, external diffs and text converters off, reads paths
  literally, refuses `..`, and shows nothing of a work tree outside the folder.
- **A terminal is your shell, as you, with the same doors.** A terminal runs your login shell on
  this computer, in the folder a request names (in the app, the session's), and can do there
  whatever you can in a terminal. Its socket opens only as Pelican's other one does: a signed-in
  browser, on Pelican's own page (its `Origin`), under a host name Pelican answers to; it closes
  within a second once that browser is signed out, and takes nothing more from it; and it runs in a
  folder as Claude Code does, so a folder nobody trusted that brings programs is asked about first,
  and in one kept to your settings only, git runs none of the repository's filters, file-system
  monitor or hooks folder (the settings Claude Code and `!` commands get there). The shell's
  environment has none of Pelican's settings (`PELICAN_*`), npm's (`npm_*`, `INIT_CWD`, `NODE`),
  Claude Code's own (`CLAUDECODE` and every `CLAUDE_CODE_*`: how it was started and, for a Pelican
  started from a Claude Code session, that session's id, its messaging socket and the token for it)
  or the Agent SDK's (`CLAUDE_AGENT_SDK_*`), nor what describes the terminal or service Pelican runs
  in; your login shell then reads your own profile, as any terminal's does. At most 10 terminals run
  at once, each shown on at most 8 pages, and a page sends at most 64 KB at a time; a page that
  stops reading is let go rather than kept in memory, and the shell waits for a slow one instead.
  What the server keeps of a terminal's screen,
  and what a page draws of it, is bounded too: 2,000 lines, at most 11 combining marks on a
  character and 14 UTF-16 code units in a cell (so six of the marks past U+FFFF, two units each),
  which keeps each cell one string of about 40 bytes (a 500x300 terminal full of Zalgo text takes
  about 50 MB; at 16 marks it took 362 MB), however many a program prints and whatever it puts
  between them, the latest 2,048 links (OSC 8) on a page, each to an address of at most 2,083
  characters, none on the server, no title, and at most 20 lines' worth of output for a screen
  reader to read out, also of output with no line feed in it. A sequence that repeats a character
  (REP), scrolls, inserts or deletes lines, or moves by tab stops does so at most a screen's worth
  of times (REP a line's), whatever count it gives, as more changes nothing. The server's copy, and
  a page's screen, take output in pieces of bounded work, each at most 512 characters and at most as
  many sequences that work over the whole screen (a reset, DECALN, erasing it, scrolling it,
  inserting or deleting lines or columns, the alternate screen) as cost about the same at its size,
  a few at 500x300, where one costs up to a millisecond or two; a reset right after a reset is not
  done again; the shell waits while the server's copy has more than a quarter of a second of such
  work before it, as it does for a megabyte of output; and a terminal closed takes nothing more in.
  So the rest of Pelican, and a page's taps, are answered in between, also while a program floods
  the screen with them, as `cat` of a hostile file can. Output xterm throws on stops neither Pelican
  nor a page's screen. A terminal lives in memory only: one unused for 12 hours with nothing running
  in it is closed, closing one hangs up its shell (SIGHUP, as closing a window does), and all end
  with Pelican. Clear terminal sends the shell nothing: Pelican clears its copy and the pages, then
  tells the program in front of the shell, found with `ps`, that the window changed (SIGWINCH, as a
  resize does), so it draws its screen again, or, where that group is not this account's to signal,
  changes the terminal's size by a row and back. Nothing runs in a terminal without you: the page
  sends its shell only what you type, paste or click, a paste without its control characters, so
  text copied from a web page cannot end the shell's paste early and run (the server's copy answers
  what a program asks of the terminal, once, a color too, from the colors the page says it draws
  in), and Run in terminal, on a shell command in Claude's reply (never in a file, or a tool's or a
  subagent's output) or on a command Claude ran or you ran with `!` (never one you denied, nor a
  subagent's or a workflow's step, and a PowerShell one only where the terminal runs PowerShell),
  asks before it runs it, its question showing the whole command, wrapped, its lines numbered and
  counted and its blanks drawn (· a space, → a tab), never only what fits a block that scrolls
  sideways; and it is there only for a command that shows all it holds: none with a control
  character a shell takes as a key, or anything an approval would write out (a character that hides
  or turns text around, or a space other than a plain one where a shell reads it as part of a word,
  read as above), nor one laid out to put part of itself out of sight: a run of more than 16 blanks
  (as 300 spaces after `ls -la` hid a `; touch …` that ran), more than 2 blank lines in a row, a
  line wider than 500 columns or more than 50 lines; all of which the server refuses too, by the
  same reading. The command is not typed at the shell's prompt, where bash, zsh and csh expand a `!`
  from the history first, double quotes and all, so `echo "!?SECRET?"` would print a secret from
  your history file, or a `curl` send it off: the shell reads it from a file of its own (`. file`,
  `source file`), in a folder only you can read, removed with the terminal, and it runs as it reads.
  Claude sees nothing of a terminal unless you put it in a message (Quote, at most its first 1,500
  characters). A link in a terminal says where it goes before it opens, as the browser would ask for
  it (an international name in its `xn--` form): pointed at, at the foot of the screen, and tapped
  on a phone, in a question with Open, since a program's link (OSC 8) can read as any words; it
  opens only with Cmd or Ctrl held, or once Open is tapped, and only an `http` or `https` one, in a
  new tab with no way back to Pelican. The demo has no terminal, and `--no-terminal` turns them off.
  The native part, `@lydell/node-pty`, is pinned to one version, and CI checks that its files, for
  every platform, are those of Microsoft's node-pty of that version, against the integrity the npm
  registry publishes for it; that the few lines of its own, which pick the platform's files, are
  those read for that version; and that none of its packages runs anything as npm installs it.
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
- **Pelican changes nothing in git, and asks GitHub only about a pull request Claude named.**
  Commit changes and Create PR, in Changes, are requests to Claude, in Claude Desktop's words: Claude
  runs git and gh, under your permission rules and hooks, as for any request; Pelican has no Push.
  A pull request's card, for the address Claude named in Desktop's `<pr-created>` tag, asks the
  GitHub CLI as you, where it is installed and signed in: `gh pr view <address> --json
  number,title,state,isDraft,headRefName,baseRefName,statusCheckRollup`, run directly (never through
  a shell), only for an address of the form `https://github.com/<owner>/<repo>/pull/<n>`, from the
  system's temporary folder (no repository), with gh's prompts off and none of Pelican's settings in
  its environment, within 10 seconds, and at most every 30 seconds for one pull request, whatever
  pages ask. It reads; it changes nothing. The demo asks nothing.
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
- **Of Claude Code's settings, Pelican writes four keys of one file, when you pick them.** What
  new sessions start with is Claude Code's own settings: Pelican reads them through the Agent SDK's
  `resolveSettings`, the user's, a folder's (only once the folder is trusted, as a session there
  would) and managed ones, which runs nothing. Settings › New sessions start with, and a model, an
  effort or fast mode picked in a session's model sheet, change Claude Code's user settings file
  (`settings.json` in `CLAUDE_CONFIG_DIR`, else `~/.claude/settings.json`) as Claude Code's own
  `/model`, `/effort`, `/fast` and `/config` do, and nothing else: `model`,
  `modelSettings.<model>.effortLevel` (Low to Extra high), `fastMode` (true, or taken out) and
  `permissions.defaultMode` (Manual, Accept edits, Plan or Auto). Bypass is never written: the
  server refuses it, as it refuses any other key, two changes at once, a model Claude Code does not
  list and Max effort. Only a signed-in request from Pelican's own page gets there, and the demo
  neither reads nor writes the file. The file is read, the change merged in with every other key
  kept as it was, and the whole written as Claude Code writes it (two-space JSON and a newline): to
  a temporary file beside it with its permissions, synced, then renamed over it, so no program
  ever reads half a file; a symlinked file is written at its target, the link kept. Just before
  the rename the file is read again: if it changed meanwhile (Claude Code saving `/model`), the
  change is made again on top of what is there, never over it, and after five tries Pelican gives
  up and says so. A file that is not valid JSON, holds no object or is larger than 2 MB is left as
  it is, and Settings says so. Pelican writes no folder's settings and no managed settings, and
  never a key that grants anything, such as `permissions.allow` or hooks. Where your own or managed
  settings make Bypass the default, new sessions start in it, as Claude Code's do, and Settings and
  the new session's mode sheet say so; a folder's own Bypass or Auto is not taken, as in Claude
  Code.
- **A side chat only reads.** It runs with Read, Grep and Glob alone, no MCP servers, in Don't ask
  mode with every other request refused, takes no `/` or `!` commands, and stays that way whenever
  Pelican resumes it or a branch of it.
- **What gets installed is what was tested.** The packages Pelican's server uses are built into
  it, as CI tested them, and npm installs two: the Agent SDK, pinned to one version, with the
  Claude Code it bundles for your computer, and the terminal's optional PTY, `@lydell/node-pty`,
  pinned to one version, with its native module for your computer, which that version pins to its
  own, each checked against the registry's integrity hash. Beside them npm installs the packages
  the SDK lists as its peers, which Pelican never loads. The package ships no
  `npm-shrinkwrap.json`: from one, npm installs Claude Code for every platform.
  `THIRD_PARTY_NOTICES` in it names each package built in, with its version and license.
- **An update installs only pelican-cc, from npm's registry, and only when you ask.** Once a day,
  and when Settings opens (at most every five minutes), Pelican asks the registry npm uses
  (`npm config get registry`, run by the npm beside the Node running Pelican, as all npm commands
  here are) for pelican-cc's document, and nothing else; when it names a newer version as `latest`,
  Pelican downloads that version's tarball from the registry, checks it against the integrity the
  registry gives, and reads its `CHANGELOG.md`, which Settings shows as text (no HTML; a link opens
  in a new tab). Offline, or when the registry fails, it says nothing. With an update to show,
  Pelican finds how it was installed, once: from the real path of its own script and
  `npm prefix --global`. It updates itself only where npm installed it into npm's global folder, and
  this account can write there; anywhere else (npx, a source checkout, another prefix, a project,
  pnpm, Yarn, Bun, Volta, a folder root owns) it shows the command to run instead, and why, and
  never installs over a version something else keeps. Nothing is installed until the signed-in owner
  presses Update on Pelican's own page: the same checks as every change (Pelican's header, its
  origin, signed in), refused in the demo, and the site's demo has no server at all. The request
  must name the very version the registry named newest, and Pelican writes the command itself, run
  directly, never through a shell,
  `npm install -g --prefix <folder> --registry <registry> --ignore-scripts pelican-cc@<version>`
  (with its audit, funding and update notices off): first into a new folder in the system's
  temporary folder, where `node <its pelican> --version` must say that version (the folder then
  goes), then into this install's prefix; npm checks every tarball against the registry's integrity,
  and runs no package's scripts. Then `node <pelican> --version` again; if it fails, npm installs
  the running version back. Then, as Pelican's service,
  `launchctl kickstart -k gui/<uid>/io.github.ki-seki.pelican` or
  `systemctl --user --no-block restart pelican.service`; in a terminal, Pelican ends what it runs,
  as a stop does, and starts its own script again in its own process (`process.execve`), with the
  arguments and environment it was started with; on a Node without it, it says to restart it. While
  the install is replaced, Pelican starts nothing new. Pelican never runs `sudo`.
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
long they waited for you, a note of the running server, and what the last look for an update found,
in `~/.local/state/pelican`. Its pins and archive are its own: Claude Desktop's are neither read nor
written. Terminals, and what they show, are kept in memory only; a command Run in terminal runs is
written for its shell to read, in a folder of the system's temporary one that only you can read,
and removed with its terminal, and that folder when Pelican stops.

## Reporting a vulnerability

Please report it privately through
[GitHub's security advisories](https://github.com/Ki-Seki/pelican/security/advisories/new) rather
than in a public issue. You will get an answer within a few days.

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
  renewed, so a browser stays signed in until it goes 30 days unused. Signing out signs that
  browser out on the computer too: its cookie, and every renewal of it, is refused from then on,
  until the last could have expired, and what that browser has open, its live updates and its
  terminals, closes at once, in every tab. Pelican keeps such sign-ins in its state folder (a hash
  of each one's id, never its cookie), so a restart or an update keeps them refused, at most 256 of
  them: past that, the oldest make room, and every cookie no newer than theirs is refused with
  them. Failed sign-ins are limited
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
  slash commands, skills and agents that run a shell or tools without asking, and in its git config
  what git runs on its own or for a command run there: filters, a file-system monitor, a hooks
  folder and hooks the config names (`hook.<name>.command`), an external diff, a diff driver's
  command and text converter, a pager, an editor and a rebase's, a merge driver, the program SSH
  runs as, a password prompt, credential helpers, a proxy for git://, an ext:: remote's command and
  the setting that lets one run, a remote's upload-pack and receive-pack, a command for an
  alternate's refs, a recent objects hook (garbage collection), `add -p`'s diff filter, a
  trailer's command, a submodule's update command, a signing program, aliases (which `!` makes a
  shell command, and `-c` can give any setting), and the programs of git mergetool, difftool,
  help, send-email, imap-send, instaweb, git gui and git svn; and hooks its own hooks folder came
  with (a tarball's `.git` keeps them). Claude Code asks before it runs them in a terminal, but never in a
  session started through its SDK, so Pelican asks. Its Claude Code settings can also pick what a
  session starts with and what it costs, a model, an effort, fast mode, Ultracode or a mode (Plan
  too), which count only once the folder is trusted, as in Claude Code: until then a new session's
  model and mode sheets say they wait, and they are asked about with its programs. Before Claude
  Code first starts in a folder nobody has trusted that brings any of these, Pelican lists them,
  read from the folder's files as Claude Code reads them
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
  and git runs none of the repository's programs: Claude Code, and every git it starts, gets git
  settings (`GIT_CONFIG_*`) that give each setting of the repository's that names one your own
  value, from your system and global git config, or else one that runs nothing of the folder's: no
  filter, file-system monitor or hooks, its own hooks folder's and those its config names included
  (`hook.<name>.enabled` false); an external diff and a diff driver's command of nothing, which git
  cannot be told to leave out, so `git diff` there stops rather than run them
  (`git diff --no-ext-diff` shows the diff); `cat` as a text converter, which shows a file as it
  is, and as `add -p`'s diff filter; the pager in `PAGER`, or less, for each command it gives a
  pager of its own too (git keeps a `pager.<cmd>` it read before when told only `true`, so the
  command gets the pager itself, or `false` where yours says not to page it); the editor in `VISUAL`
  or `EDITOR`, else vi, for a commit's message and a rebase's list; git's own merge
  (`git merge-file`) for a merge driver; `ssh`; no password prompt; no proxy for git://
  (`GIT_PROXY_COMMAND` empty, as git takes the first `core.gitProxy` it reads, the folder's, so
  yours is left out there too); no ext:: remote (`protocol.ext.allow` never); `echo` as a
  trailer's command, which keeps the value given; `checkout` to update a submodule; `true` for an
  alternate's refs; the format's own signing program; aliases, and the programs of mergetool,
  difftool, the browser, send-email, imap-send, instaweb, git gui and git svn, of nothing, and `man`
  to show help; and its credential helpers emptied, then yours again. A folder whose git config git
  cannot read in full does not start that way, nor one whose config names what git cannot be told
  to leave out: a remote's upload-pack or receive-pack (git takes the first it reads, the folder's)
  or a recent objects hook (git runs every one it reads); Trust and start runs them. A folder is trusted when
  Claude Code's own record says so (its trust dialog, read and never written), when you trusted it
  in Pelican, when Pelican made it (a scratch folder), or when Claude Code has worked there before,
  unless you chose your settings only for it. Listing a folder's slash commands or MCP servers
  starts Claude Code with hooks off and, in a folder nobody trusted, from your home folder with your
  settings only; git does not run there at all. In a trusted folder, git runs for the Changes panel
  with hooks, the file-system monitor, external diffs, diff drivers, text converters and the pager
  off, git's own commands only (no alias), and no transport at all, so no SSH command, credential
  helper or password prompt, and nothing fetched for a partial clone's missing files; it reads
  paths literally, refuses `..`, and shows nothing of a work tree outside the folder.
- **A terminal is your shell, as you, with the same doors.** A terminal runs your login shell on
  this computer, in the folder a request names (in the app, the session's), and can do there
  whatever you can in a terminal. Its socket opens only as Pelican's other one does: a signed-in
  browser, on Pelican's own page (its `Origin`), under a host name Pelican answers to; it closes
  within a second once that browser is signed out, and takes nothing more from it; and it runs in a
  folder as Claude Code does, so a folder nobody trusted that brings programs is asked about first,
  and in one kept to your settings only, git runs none of the repository's programs (the settings
  Claude Code and `!` commands get there, as above), and where git cannot be told to leave one out,
  no terminal starts there. The shell's
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
  `source file`), named so that nobody can guess it, in a folder of Pelican's state folder that only
  you can read. The folder is made again if it has gone, and checked before each command goes in
  it: a folder of yours, not a link, or no command is written and Run in terminal says why. The file
  is made new, never through a link, and goes with its terminal (one left behind when Pelican was
  stopped goes a day later); where the state folder's path has a space, or others may write in it,
  it goes in a folder made for it alone in the system's temporary folder. The command runs as it
  reads: bash and zsh expand no `!` in a file they read, and csh and tcsh, which do, are told to
  expand none while they read it (`histchars` emptied), and have it put back as it was after, by a
  second file read on the same line, which tcsh goes on to also when the command stops on an error
  or Ctrl+C. The shell's history gets the command itself, for Up and Enter, rather than the line
  that read its file: bash, zsh and fish 4 are told to add it, quoted so that nothing in it is
  expanded as it goes in; bash takes out the line that read the file, found by the file's name, and
  nothing else, and fish, and zsh set to HIST_IGNORE_SPACE, keep it out, as it is typed with a space
  before it.
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
- **Pelican changes nothing in git, and asks GitHub only about a pull request Claude named.** Commit
  changes and Create PR, in Changes, are requests to Claude, in Claude Desktop's words: Claude runs
  git and gh, under your permission rules and hooks, as for any request; Pelican has no Push. A pull
  request's card, for the address Claude named in Desktop's `<pr-created>` tag, asks the GitHub CLI
  as you, where it is installed and signed in: `gh pr view <address> --json
  number,title,state,isDraft,headRefName,baseRefName,statusCheckRollup`, run directly (never through
  a shell), only for an address of the form `https://github.com/<owner>/<repo>/pull/<n>`, from the
  system's temporary folder (no repository, nor one Pelican's environment names), with gh's prompts
  off and none of Pelican's settings in its environment, within 10 seconds, at most four at once,
  and at most every 30 seconds for one pull request, whatever pages ask: an answer is kept for 30
  seconds, for at most 256 pull requests, and one asked about past them gets no status until an
  answer is that old. A reply has at most five cards. It reads; it changes nothing. The demo asks
  nothing. Only such an address's card names a repository as GitHub's: a card for any other names
  its host first, whole, as the browser would open it (a name in another script as its punycode,
  without a user name), so a host made to look like GitHub's reads as what it is.
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
  `resolveSettings`, the user's, a folder's (only once the folder is trusted, as in Claude Code, and
  never where you kept it to your settings) and managed ones, which runs nothing. Settings › New sessions start with, and a model, an
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
  ever reads half a file; a symlinked file is written at its real path, every link on the way
  kept, also a link to a link (Claude Code's own writer follows one link, and would put a file in
  place of the second). Just before
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
  Pelican resumes it or a branch of it. Each branch Pelican makes of a side chat is marked as a side
  chat of its own (Claude Desktop's "Side chat" title under its own id, its name kept after it), so
  it stays one when the side chat it came from is deleted, cleaned up by Claude Code, or many
  branches back.
- **What gets installed is what was tested.** The packages Pelican's server uses are built into
  it, as CI tested them, and npm installs one: the terminal's optional PTY, `@lydell/node-pty`,
  pinned to one version, with its native module for your computer, which that version pins to its
  own, checked against the registry's integrity hash. The package ships no `npm-shrinkwrap.json`:
  from one, npm installs every platform's native module. `THIRD_PARTY_NOTICES` in it names each
  package built in, with its version and license.
- **The Agent SDK is Anthropic's own package, fetched once for each version.** Its license lets no
  one else ship its code, so Pelican's package holds none of it, and no Claude Code: Pelican runs
  the user's own (`PELICAN_CLAUDE_PATH`, else the first `claude` on PATH in absolute folders only,
  else where Claude Code's installers put it). The first time Pelican needs the SDK, outside the
  demo, it runs `npm install --prefix <folder> --no-save --no-package-lock --omit=optional
  --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-agent-sdk@<version>`, with the exact
  version Pelican was built and tested with, into a new folder in `<state>/agent-sdk` (which only
  the user can read) and from that folder, so no project's `.npmrc` names the registry: the npm
  beside the Node running Pelican (else the first npm on PATH), with the user's own npm settings
  and nothing an earlier npm left in the environment.
  npm checks each tarball against the registry's integrity and runs no install script; the SDK's
  optional packages, each a copy of Claude Code, are left out, and the packages it lists as its
  peers come with it, which Pelican never loads. Only a whole copy of that version then takes its
  place, `<state>/agent-sdk/<version>`, folder and all, so a Pelican starting meanwhile finds it or
  not, never half of it; copies of other versions are then removed. Where npm installed the SDK
  beside Pelican's code (in development, and in the tests), that copy is loaded instead. The demo
  loads none.
- **An update installs only pelican-cc, from npm's registry, and only when you ask.** Once a day,
  and when Settings opens (at most every five minutes), Pelican asks the registry a global install
  uses (`npm config get registry --global`, run by the npm beside the Node running Pelican, from
  your home folder, as all of an update's npm commands are, so that a project's `.npmrc` in the
  folder Pelican was started from names nothing) for pelican-cc's document, and nothing else; when it
  names a newer version as `latest`, Pelican downloads that version's tarball, only from the
  registry's own origin (a tarball elsewhere is left to npm, and Settings links to the release
  notes instead), checks it against the integrity the registry gives, and reads its `CHANGELOG.md`
  as it unpacks, which Settings shows as text (no HTML; a link opens in a new tab). It reads at
  most 16 MB of the document, 32 MB of the tarball, 64 MB of it unpacked and 2 MB of the changelog,
  sends Settings at most 64 KB of what changed, and downloads a tarball whose changelog it could not
  read no more until the registry answers again. Offline, or when the registry fails, it says
  nothing. It keeps the last answer for its next start, and takes it then only as it would take the
  registry's own, from the registry npm names then, and not dated ahead of the clock. With an update
  to show, Pelican finds how it was installed, once: from the real path of its own script and
  `npm prefix --global`. It updates itself only where npm installed it into npm's global folder, and
  this account can write there; anywhere else (npx, pnpm dlx, bunx, a source checkout, another
  prefix, a project, pnpm, Yarn, Bun, Volta, a folder root owns) it shows the command to run
  instead, and why, and never installs over a version something else keeps. Nothing is installed
  until the signed-in owner presses Update on Pelican's own page: the same checks as every change
  (Pelican's header, its origin, signed in, a body of at most 1 MB), refused in the demo, and the
  site's demo has no server at all. The request must name the very version the registry named
  newest, and one update runs at a time: a request while another is asked for or under way is
  refused. Pelican writes the command itself, run directly, never through a shell,
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
  the install is replaced and Pelican starts again, nothing new starts through it: every change
  waits for the new version, and so does every read that would start Claude Code, git, gh, a
  terminal, a search or Tailscale's command line, or ask the registry; reading what is there goes
  on. Pelican never runs `sudo`.
- **A service holds no secret.** `pelican service install` writes your `PATH` and Pelican's and
  Claude Code's settings into the launchd agent or systemd unit, made readable only by you even
  when the file was there before. It never writes a variable whose name says it is a key, a token,
  a password or headers, nor an address with a user name or password in it; its log never holds
  the sign-in link. Nor does it write what Claude Code, or the app or IDE that runs it, sets for one
  session: run inside a Claude Code session or an IDE's terminal, it leaves out `CLAUDECODE`, that
  session's id, its inbox socket and the token for it, the IDE's port, how Claude Code was started
  and the like, which every session the service runs would otherwise take for its own.

Pelican keeps no copies of your sessions: it reads Claude Code's transcripts where Claude Code
writes them, and saves a `!` command's output too long for the conversation where Claude Code saves
one, in the session's `tool-results` folder, readable only by you. It stores uploads, push
notification keys and subscriptions, the sign-ins signed out until their cookies would have
expired, the folders you trusted or kept to your settings, which
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

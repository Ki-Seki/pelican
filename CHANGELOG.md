# Changelog

## 0.3.0

Every Claude Code session on your computer, on your phone. This release follows a ten-angle audit
(first run, phone, computer and accessibility, the conversation, Claude Code parity, the server,
security, the launch, competitors, code quality) and an adversarial review of the result.

### Highlights

- **Phone in one step.** `pelican phone` prints a QR code that opens Pelican on your phone, signed
  in, once, for two minutes. It finds the address from `tailscale serve`, PELICAN_PUBLIC_URL or your
  network; with Tailscale it is two commands. The start banner shows the code when it knows the
  address.
- **Keeps running.** `pelican service install` (also `status`, `restart`, `uninstall`) starts
  Pelican at login with launchd or a systemd user service. While Claude works, the computer does not
  idle to sleep (PELICAN_KEEP_AWAKE=0 turns this off).
- **Sessions waiting in other apps.** A session waiting for an answer in the terminal, Claude
  Desktop or VS Code shows "Needs you in the terminal", and your phone gets one notification if the
  wait lasts about 20 seconds. You answer it in that app.
- **Approvals as in Claude Code.** "Always allow" says what it saves and where ("Always allow
  `npm test *` in this project", "Allow all edits this session"), and is not offered when Claude
  Code says it would allow more than asked. Deny works like Claude Code's No. Cards use Claude
  Code's wording, name the subagent or MCP server asking, and show hidden characters in commands.
- **Folders you trust.** The first time Claude Code would start in a folder nobody trusted, and
  the folder brings programs of its own (hooks, MCP servers, helpers, git filters), Pelican lists
  them and asks: Trust and start, or Use my settings only.
- **Much lighter on a phone.** Replies stream as appends (a long answer costs a few percent of
  the data it did), everything is sent compressed, the conversation loads only when you open one,
  pictures load when shown, and the session list stays fast with thousands of sessions.

### Changes in behavior

- New sessions start in Auto, unless you pick a mode in Settings (New sessions start with > Mode)
  or Claude Code's `permissions.defaultMode` sets one; a model without Auto starts in Manual. Bypass
  is never a default: a branch, an edited earlier prompt or `/clear` from a Bypass session starts in
  that default mode. A mode picked in a session stays with it.
- Permission modes carry Claude Code's names: Manual, Accept edits, Plan, Auto, Bypass
  permissions. A session in Claude Code's Don't ask mode keeps it.
- Deny with no note stops the turn and waits for you; with a note, Claude carries on with it.
- Queued messages wait in a strip above the message box, where you can edit or remove them, and go
  to Claude when the turn ends, each as its own message, so a queued `/compact` or `/model` runs as
  a command.
- Stop ends the turn but leaves background agents and commands running, as Esc does in the
  terminal; each has its own Stop.
- `/clear`, `/reset` and `/new` open a new session in the same folder.
- Pages and visuals Claude makes show as still pictures until you tap Run, and only for tool calls
  that ran.
- A browser in use stays signed in; 30 days without use sign it out. `pelican token --reset` and
  `pelican password` apply at once.
- The Agent SDK, and the Claude Code it brings, is pinned, and the package ships
  npm-shrinkwrap.json: installs get the tree that was tested. Updating Pelican updates its Claude
  Code. A second command name, `pelican-cc`, is there for machines where `pelican` is taken.
- Uploaded attachments are deleted after Claude Code's `cleanupPeriodDays` (30 unless set).

### Sessions and the list

- Sessions with the same folder and title (a scheduled task's runs, a named session's branches)
  fold into one row, with the earlier ones a tap away.
- A session whose background commands, subagents or scheduled checks keep running after its turn
  stays under Active, with "2 tasks" and a steady dot.
- A turn that ended on a Claude Code error shows "Stopped: not signed in" (or the error's kind)
  instead of the error as Claude's reply.
- Titles taken from a prompt fit on about one line; renamed sessions and Claude Code's own titles
  keep theirs.
- Archive from the list: swipe a row left on a phone, or use the button on hover, with Undo.
- Rows are links (Cmd/Ctrl-click opens a new tab), the open session is marked, and long lists load
  150 rows at a time while search still covers every session.
- + opens a new chat in your latest project, ready to type; tap the folder to start elsewhere, or
  make a new folder there (New folder in the folder browser).

### The conversation

- Opening a session lands on its newest message, also with pictures, a chart or an approval
  waiting. While Claude works the view follows the newest output; a stray tap no longer stops that.
- Diffs wrap long lines. Code blocks have a bar with the language and Copy. Tool output shows
  without color codes or error tags. Long prompts fold, and files you sent show as chips.
- What you decided stays visible: your answers to Claude's questions, plans approved or sent back,
  steps you denied with your note.
- The task list shows in full when it changes; in between, progress is one line.
- Half-written messages are kept per session, with their files, across leaving and reloading.
- Several approvals come one at a time ("1 of 3") and never push the message box off screen.
- Drop files anywhere on the conversation to attach them.
- A session another app has looks the same everywhere: the header says "Working in the terminal"
  or "Needs you in Claude Desktop", each case is explained once, and the message box warns that
  sending starts a second Claude.
- API failures show once, in plain words (overloaded, too long: send /compact, not signed in,
  usage limit and when it resets).
- Hook feedback, warnings and local command output appear as notes, and stay after the turn and a
  reload; terminal-only commands are left out of the / list.
- MCP servers that ask for input get a card to answer instead of being declined.
- Plans can be approved into Auto, Accept edits or Manual, or sent back with Keep planning.
- Check-ins Claude schedules (/loop, reminders, session crons) are listed, and Claude keeps running
  for them and for background work.
- The cost shown is that turn's own, not the running total, and none on a subscription.
- Notifications say what Claude wants (the command, the file, the question) or the reply's first
  line.
- On screens 1440px and wider, Changes and files sits beside the conversation (Cmd/Ctrl+Shift+D,
  as in Claude Desktop). Comment on diff lines and add the comments to your message.

### Keyboard and accessibility

- Enter that confirms a Chinese, Japanese or Korean candidate never sends, Safari included.
  Cmd/Ctrl+Enter always sends. Esc stops Claude. Cmd/Ctrl+K searches sessions. Cmd/Ctrl+/ lists
  the keys.
- Sheets are real dialogs: focus moves in and back, one Esc closes one, and on a phone you drag a
  sheet down to close it.
- Screen readers hear approvals, questions, plans, replies, failures and the connection state;
  turns have headings and pictures have names.
- Grey text and status words pass WCAG AA contrast in both themes; Reduce motion stops the pulsing.
- On iPhone the message box stays above the keyboard and fields no longer make Safari zoom.

### Reliability

- Nothing a request or an unreadable transcript does crashes the server any more.
- A chat no longer stays on "Working" after Claude finished while the phone slept or Pelican
  restarted. Dead connections are noticed and replaced; coming back to the page catches up at once.
- When the computer cannot be reached, one quiet line says so, with Retry.
- A `!` command that leaves something running in the background returns at once.
- A named pipe or device file in a project can no longer freeze Pelican.
- On Linux with Node 24, a Claude Code that Node runs (Node names its main thread MainThread) is
  recognized again as working in another app.
- A signed-out or missing Claude Code is detected and said in Pelican's words; the banner and
  Settings > About say which Claude Code runs, and when your own `claude` is newer.

### Security

- Folder trust, above. Typing `/` or `@` in an untrusted folder runs nothing of the repository's.
- The app's own page has a script and connect policy; previews run their scripts only after Run.
- Notifications stop on every device after a token or password change, and on sign-out.
- `pelican service` never copies secrets such as API keys into the service.

### Site, docs and project

- The README and website were redesigned around the one line, the live demo, how it works, a
  dated comparison with Remote Control, Happy and HAPI, Yep Anywhere, CloudCLI and SSH with tmux,
  and answers to the questions launch threads ask (plan terms, Remote Control, tmux, sleep, cost
  and telemetry, size).
- The docs cover everything above and add a Claude Code coverage table, Keep it running, Update
  and remove, and Folders you trust.
- The live demo plays out the waiting approval and answers messages calmly.
- CI runs the app and the site in a real browser on every change, on Node 22.12, 24 and 26 and on
  macOS; the site publishes only after CI passes. Release candidates publish as `next`.
- Each new Agent SDK arrives as its own pull request with a report of what changed upstream, and a
  weekly issue lists Claude Code updates to consider.

## 0.2.3

- A session keeps its own model, effort, speed, Ultracode and permission mode, Bypass included:
  leaving and coming back, or Pelican restarting, no longer turns Opus 5.5 into Default or
  Bypass into Ask. What new sessions start with is set in Settings alone; a choice in one
  session stays in that session. A branch still starts by asking first.
- The view (Summary, Normal, Verbose) can differ per session, from the session menu; Settings
  holds the one the others open in.
- The session list's options moved next to the search and are no longer repeated in Settings.
  Settings, the session menu and the model sheet say less.
- Dictation explains why it stopped: a blocked microphone, a page that does not let Pelican use
  it, or a browser without a speech service.

## 0.2.2

- That a session is also open, idle, in another app is explained once, the first time it
  happens, and then only in the session menu; the banner no longer sits above the composer of
  every such session. A session another app is working on still says so plainly.
- Releases publish to npm from GitHub Actions through npm's trusted publishing, with
  provenance: no npm token exists, and only the release workflow may publish.

## 0.2.1

The first public release.

- Runs on its own: `npm install -g pelican-cc`, then `pelican`. It listens on `127.0.0.1` and
  every browser signs in, also on this computer: with the link Pelican prints (an access token,
  as in Jupyter; `pelican token` prints it again) or with a password (`pelican password`).
  `--no-auth` is for when a proxy in front already authenticates. Requests must come from
  Pelican's own page, under a known host name, and no other site may frame it. See
  [SECURITY.md](SECURITY.md).
- Images in a reply load only from Pelican; pages and visuals Claude makes cannot reach any server
  but the public CDNs. A folder Claude has not worked in loads only your user settings when
  Pelican looks at it, and git does not run there; where Claude has worked, git starts no hooks,
  file-system monitor, external diff or text converter (your filters, such as Git LFS, run as in
  your own git). The QR code that opens Pelican on a phone carries a one-time code.
- `pelican --demo` shows made-up sessions, with nothing of yours involved.
- Every session's whole history, back past each compaction, with a divider where the context was
  compacted; older pages load as you scroll up.
- Three ways to read a session (Summary, Normal, Verbose), and a settings page: theme, the default
  view, what Enter does, how the session list is grouped and how dense it is, notifications.
- A menu for each session: rename, branch, export as Markdown, delete, copy the command that
  continues it in a terminal. Edit an earlier prompt in place, images and all, and send it again:
  only then does the conversation branch, in one step that leaves nothing behind if it fails.
- Claude Desktop's side chats are folded out of the list (Settings shows them); background tasks
  fold into one row when there are several. Archive puts a session away from the list without
  touching it.
- A session open in another app too says so; before sending, Pelican catches up with what was
  said there instead of continuing an older version of the conversation.
- Editing the last prompt replaces it in place, as rewinding does in Claude Code; an earlier
  prompt still branches. Model, effort, fast mode and ultracode changed while Claude works apply
  at once, and a choice not yet used stays with the session.
- Settings shows the plan's usage as Claude Code's `/usage` does: the 5-hour and weekly windows,
  or, on Team and Enterprise, the month's extra usage against its cap.
- `/` commands and `@` files in the composer, ultracode next to effort and fast mode, the task list
  pinned above the composer, how full the context is, and each turn's time, tokens and cost.
- Images open full screen. A failed send gives the text back to edit.
- While Claude works, a message steers it (read at its next step) or waits for the turn: tap the
  word next to Send. Messages sent mid-turn, from any app, show where Claude read them.
- `!` commands run in the session's folder; Claude reads the output with the next message.
- Changes and files: every changed file with its diff, and the folder to browse and mention.
- Rewind code to before any prompt; open the steps a subagent took; MCP servers with their
  status; the plan's usage limits; background tasks with Stop; suggested next prompts.
- Charts and diagrams Claude Desktop draws, pages Claude writes, files it sends, and `html` or
  `svg` blocks render in place, in a sandboxed frame.
- Dictation in the composer, and a QR code to open Pelican on your phone.
- Scrolling up while Claude streams stays where you put it; sending brings the end back into view.

## 0.1.0

A phone-first web app for Claude Code sessions: the session list, live chat with approvals,
images and files, notifications, and sessions other apps are working on.

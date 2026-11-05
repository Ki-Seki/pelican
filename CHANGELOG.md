# Changelog

## 0.4.0

Files, changes and side chats as in Claude Desktop, `!` commands you can watch, and your usage
from every app.

### Highlights

- **Changes and files.** See what each turn changed (T1, T2…, from Claude Code's own record, so
  also outside git), what is uncommitted, or everything since your branch split from main, with
  diffs, and Rewind code where Claude Code kept a checkpoint. Search the folder by name or in the
  text, and read a file with line numbers, Markdown and HTML previewed. A file a step names, or a
  `path:line` in a reply, opens at its line, and under a turn that edited files "3 files changed"
  opens them. On a phone it is a view of its own that the back gesture steps through; on a computer
  it sits beside the conversation from 1024px wide.
- **Side chats.** `/btw`, Cmd/Ctrl+; or Side chat in the session menu asks something on the side,
  as in Claude Desktop. Claude answers from a read-only copy of the session (Read, Grep and Glob,
  no MCP servers, never Bypass), and nothing goes back to the session, which keeps working. It sits
  beside the conversation from 1024px wide, taking turns with Changes and files, and is a sheet on a
  phone. Side chats are Claude Code sessions titled "Side chat", folded under their session, and
  continue in the CLI and Desktop; opened from the list, one keeps its box for questions only.
- **Quote.** Select text in a reply, a step's output or a file and tap Quote. The quote waits
  above the message box with your draft and goes above your words as a `>` quote; lines of a file
  carry where they are, as `src/app.ts:7-8`.
- **Live `!` commands.** Output as it comes, with Stop, for up to 30 minutes. When a command ends,
  Claude answers it, as in the CLI, unless `respondToBashCommands` is false. Commands are written
  the way Claude Code writes them, so the terminal and Desktop show Pelican's, and Pelican shows
  theirs.
- **Usage and activity.** Settings > Usage and activity shows your Claude Code usage on this
  computer, from every app: tokens of each kind over 7 days, 30 days or all time, per day,
  sessions, active days and streaks, and where they went by project, model, app and session, with
  a few highlights. On a plan its limits are at the top; on an API key or a provider, the cost
  Claude Code estimates. Each reply counts once, also when it was copied into a side chat or a
  branch. The session menu shows what that session used.

### Changes in behavior

- Line comments go with your next message in the session they were written in, before your words,
  as in Claude Desktop, or on their own with Cmd/Ctrl+Enter, instead of Add to message. They are
  kept across reloads and forgotten on sign-out.
- Transcript views are Claude Desktop's: Normal, Thinking and Verbose, and Ctrl+O steps through
  them. Thinking shows in a session's menu once Claude has thought there. A session set to Summary
  opens in Normal.
- A `!` command may run 30 minutes instead of two, and Claude answers it when it ends, which is a
  turn like a prompt. A command you stop gets no answer.
- Changes and files docks from 1024px wide instead of 1440px; below 1280px the session list folds
  away while it is open, and Cmd/Ctrl+K brings it back.
- Commit, Push and Create PR, on the branch line, put a request to Claude in the message box, so
  your rules, hooks and attribution apply. Pelican runs no git that changes anything.

### The conversation

- A failed request at the end of the conversation offers Retry, which sends the prompt again with
  its files, or Compact when the conversation is too long.
- Scheduled check-ins have Cancel, which asks Claude to cancel them.
- An MCP server that needs you to sign in says where: `claude mcp login <name>` in a terminal on
  the computer, or claude.ai's connectors page.
- Approval notifications have Allow and Deny where the device shows buttons on notifications
  (Chrome on a computer or Android); questions and plans open the session.
- The session menu shows the session's tokens, the share from the cache, its models and
  compactions, and its cost where Claude Code counts one.
- A finished `!` command shows the end of its output, as it did while it ran; Show all shows the
  start. A running one's Stop is named for it.
- A message that does not go comes back to the message box above anything typed since; one sent
  for you (Send now, Compact, Retry, Cancel) leaves the box as it is.
- A path or "files changed" tapped while the side chat is open puts it away and opens Changes and
  files.
- Side chat in the session menu leaves the keys in the side chat's box. Quotes that do not fit above
  the message box fade at its edge, and removing one with the keyboard moves on to the next.
- A conversation opens without the code of Changes and files, which follows once it is up, and
  Settings without the usage page.

### Security

- Changes and files reads only regular files inside the session's folder, links followed and
  checked. Downloads come as inert attachments. Search runs the ripgrep inside Claude Code with no
  config, an empty environment, no git and no links followed.
- A side chat only reads, asks for nothing, and takes no `/` or `!` commands.
- Notification buttons go through the same checks as the page.

### Site, docs and project

- The docs cover Changes and files, side chats, quotes, live `!` commands, the views and the
  usage page, and the coverage table moves side questions, views, quotes and Create PR to Yes.
- The browser smoke test checks the docked pane at 1024, 1280 and 1440px and the side chat pane at
  1024px, where it asks a question, and opens older sessions at one size only, to keep CI quick.

## 0.3.1

- New sessions start at High effort until you pick another in Settings (New sessions start with >
  Model); picking Default there leaves the effort to Claude Code, as before. Sessions that already
  ran keep what they ran with, and a model without effort levels gets none.
- On a computer, Changes and files docked beside the conversation is no longer cut off at the
  right edge when the conversation holds long lines (the column grew to fit them).
- The website's phone pictures show the whole screen, the message box included.
- qrcode-generator 2 and esbuild 0.28 (the QR codes are the same, checked bit for bit).

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

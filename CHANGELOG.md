# Changelog

## 0.4.1

- **Files Claude sends you, as in Claude Desktop.** In the sessions Pelican runs, Claude can send
  you files (Claude Code's SendUserFile): Pelican now tells Claude Code it shows them, the way
  Claude Code expects of an app that does, which turns that tool on and nothing else. Before, the
  call failed with "SendUserFile is still listed for this conversation but is switched off in this
  session right now". A file shows where Claude sent it, as it is sent and after a reload, read
  from where Claude Code delivered it, under the words Claude sends with it, which read as a reply
  does, Markdown and all: pictures in place, side by side at their own size when they come alone and
  as small squares beside other files, larger on a tap; a video or a sound in a player, a part at a
  time, so it plays in Safari too; a page or an SVG as the still preview, with Run; text to read,
  Markdown as it reads, folded when long; a PDF in your browser's own viewer, in a tab of its own;
  anything else as a card to download, with its type, name and size. A file Claude meant you to
  save stays a card until you open it. While the call runs its step says "Sending file", and
  "Failed to send" if it fails, in Claude Desktop's words, and sent files are never folded away
  among steps. Asked to send one from outside the session's folder, the approval says "Claude wants
  to send you a file" and lists it, instead of the call's raw input.
- A file Claude sent that is no longer there, as many are in older sessions, says "No longer on
  this computer" before you tap anything, the same for every type, with its name and size and
  nothing to tap; one past 200 MB says it is larger than Pelican serves. A browser tab that opens
  one anyway says so in a page, not in JSON.
- A character in a sent file's name that hides or turns text around shows as ⟨U+202E⟩, with the
  approval's warning, on its card, in the step that sends it and in the name it is saved under: a
  script named to read as a picture no longer does.
- Files Claude sent in Claude Desktop show from Claude Code's record of what it delivered, so one
  Claude named by a relative path shows too; a file Claude Code did not deliver never shows.
- The demo, and the live demo on the website, have a file Claude sent: in "Try the dark theme on my
  phone", a screenshot of the settings page in dark.
- A download, of a file Claude sent or from Changes and files, sends the file as it was when you
  asked for it: one that grew meanwhile, such as a log still being written, went on past the size it
  had announced, and past the 200 MB limit. One cut short meanwhile breaks the download off.
- A file whose extension names what every JavaScript object has, such as `.constructor`, opens as a
  file: sent by Claude it failed with a server error, in Changes and files it showed as a broken
  picture, and as an upload it would not open.

## 0.4.0

Files, changes and side chats as in Claude Desktop, workflows and `!` commands you can watch, and
your usage from every app.

### Highlights

- **Changes and files.** See what each turn changed (T1, T2…, numbered and counted as Claude
  Code's `/diff` does until a compaction, from its own record, so also outside git), what is
  uncommitted, or everything since your branch split from main, with diffs, and Rewind code where
  Claude Code kept a checkpoint. Search the folder by name or in the text, and read a file with
  line numbers, Markdown and HTML previewed. A file a step names, or a `path:line` in a reply,
  opens at its line, and under a turn that edited files "3 files changed" opens them. On a phone
  it is a view of its own that the back gesture steps through; on a computer it sits beside the
  conversation from 1024px wide.
- **Side chats.** `/btw`, Cmd/Ctrl+; or Side chat in the session menu asks something on the side,
  as in Claude Desktop. Claude answers from a read-only copy of the session (Read, Grep and Glob,
  no MCP servers, never Bypass), and is told so with each question, as in Desktop. Nothing goes
  back to the session, which keeps working. It sits beside the conversation from 1024px wide,
  taking turns with Changes and files, and is a sheet on a phone. Side chats are Claude Code
  sessions titled "Side chat", kept out of the session list (List options > Side chats shows them),
  and continue in the CLI and Desktop; opened from the list, one keeps its box for questions only.
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
  branch; Claude Code's `/stats` counts each content block, so its totals are higher. The session
  menu shows what that session used.
- **Workflows.** A workflow (Claude Code's Workflow tool) shows as a card, as Claude Code shows
  one, instead of its script's first line: its name, Running or how it ended with its agents and
  tokens, its phases one a line (Review · 3 of 5 done) opening into their agents and each agent's
  steps, the script and the result. It is live, with Stop, in sessions Pelican runs, and read from
  the run's folder for other apps'; its end, also one that came while Claude worked (those were
  lost), leads back to the card. Asked to run one, the approval shows its phases, the args its
  script runs with and the file it runs.

### Changes in behavior

- Line comments go with your next message in the session they were written in, before your words,
  as in Claude Desktop, or on their own with Cmd/Ctrl+Enter, instead of Add to message. They are
  kept across reloads and forgotten on sign-out.
- Transcript views are Claude Desktop's: Normal, Thinking and Verbose, and Ctrl+O steps through
  them. Thinking shows in a session's menu once Claude has thought there. A session set to Summary
  opens in Normal.
- A `!` command may run 30 minutes instead of two, and Claude answers it when it ends, which is a
  turn like a prompt. A command you stop gets no answer, and one still running when Pelican stops
  gets up to 15 seconds to tidy up, then ends with it; Ctrl+C again ends it at once. Under launchd
  it gets what the login item leaves: `pelican service install` now asks launchd for 20 seconds,
  where it gave 5.
- Claude gets a `!` command's output as Claude Code's bash mode gives it, in the record Claude
  Code writes for the same output: stdout and stderr together in the order they were written, as
  much as Claude Code reads back of it, 30,000 bytes or what `bashOutputMaxChars` sets (where that
  is unset, BASH_MAX_OUTPUT_LENGTH, 1 to 150,000), instead of up to 200,000 characters of each. A
  failed one is cut there. One that went well and printed more is saved in the session's
  `tool-results` folder, where Claude Code saves one, up to 64MB, and Claude gets its start and
  where it is; so is one whose text is longer than Claude gets inline (30,000 characters, or what
  `bashOutputMaxChars` sets). Exit code 1 from grep, diff, test or find is an answer, not a
  failure, when that command is the line's last statement as Claude Code's parser reads it (not
  in a subshell or a `{ }` group; a comment is none). The record no longer adds the exit code, or
  that something runs on in the background, as Claude Code's adds neither.
- What Claude changes in answer to a `!` command is that command's turn in Changes, as in `/diff`;
  a message of files alone starts a turn, a picture sent without words none, and a new file's
  lines count as `/diff` counts them. After a compaction `/diff` numbers from 1 again, and it reads
  only the last 4,096 messages, so in a longer stretch its T1 is a later turn; Pelican, which shows
  every turn, counts on from the first.
- A renamed file's diff shows the rename and what changed in it, instead of the whole file as new;
  one renamed whole says "Renamed from …, unchanged".
- Push and Create PR, on the branch line, show only where the repository has a remote with an
  address, not one that only a system or managed git config names (a fetch line for every
  repository).
- Changes and files docks from 1024px wide instead of 1440px; below 1280px the session list folds
  away while it is open, and Cmd/Ctrl+K brings it back.
- Cmd/Ctrl+\ closes Changes and files when pressed in it, as it closes the side chat and as Close
  pane does in Claude Desktop; closed, the pane gives the keys to the button that opens it.
- The keyboard shortcuts (Cmd/Ctrl+/) list Changes and files (Cmd/Ctrl+Shift+D), Close pane
  (Cmd/Ctrl+\) and Send comments (Cmd/Ctrl+Enter), and call Ctrl+O Transcript view.
- Commit, Push and Create PR, on the branch line, put a request to Claude in the message box, so
  your rules, hooks and attribution apply. Pelican runs no git that changes anything.

### Sessions and the list

- Claude Desktop's side chats stay out of the list also once Claude Code has given them the
  session's title again, as it does when their Claude exits; most showed as more sessions with
  that title.

### The conversation

- An approval says Claude's few words on a command once, also when Claude Code passes them as its
  own line too.
- A failed request at the end of the conversation offers Retry, which sends the prompt again with
  its files, or Compact when the conversation is too long.
- Scheduled check-ins have Cancel, which asks Claude to cancel them.
- An MCP server that needs you to sign in says where: `claude mcp login <name>` in a terminal on
  the computer, or claude.ai's connectors page.
- Approval notifications have Allow and Deny where the device shows buttons on notifications
  (Chrome on a computer or Android), for a command a notification shows whole: printable ASCII with
  one space between words, on one line, short enough for two lines of the narrowest notification
  (about 50 characters, fewer when they are wide), and on Android, whose pop-up shows one line
  beside the buttons, for that one line (about 20). A notification shows the command itself, not
  Claude's description of it; edits, other tools, other commands, questions and plans open the
  session.
- Notifications and check-ins keep emoji whole, also those made of several pictures, and still
  leave out characters that hide text or turn it around, now also from a notification's title, the
  session's. Their text is cut between characters as they show, and sooner where those hold many
  code points (one letter can carry any number of accents), so a notification stays within the
  4 KB a push service carries.
- Export as Markdown has the conversation as it shows here: `!` and `/` commands as typed, as
  code, with their output; the files and pictures sent with a prompt; Claude Code's own lines,
  such as a background task's note, Interrupted, a failed request (naming the computer, as the
  conversation does) or a hook's word, and a command that failed marked so; and none of
  the tags, notes and summaries Claude Code and Pelican add for Claude, such as a side chat's note
  with each question.
- The session menu shows the session's tokens, the share from the cache, its models and
  compactions, and its cost where Claude Code counts one.
- A finished `!` command shows the end of its output, as it did while it ran; Show all shows the
  start, and for one too long for the conversation what Claude Code saved of it (up to 64MB), from
  that file, a page at a time, also in a branch that copied it. One that printed nothing shows the
  command alone, and one that failed says Failed, or Stopped, where its live card said how it
  ended; a record from before (Claude Code before 2.1.80, Pelican before 0.4) says so only where
  it noted it. A running one's Stop is named for it.
- Claude's answer to a background task's note shows after the note, not in the reply before it.
- A message that does not go comes back to the message box, files and all, above anything typed
  since. A `!` or `/` command comes back only into an empty box; with words or files there, it
  waits above the box, Not sent, with Put back, as does a message, files and all, that comes back
  while a command is typed. A `/` command goes with its words alone: files in the box wait for the
  next message, as quotes do. What waits stays across reloads, and in a new session goes on with
  the session once it starts, line comments too. Put back brings words and files back together, or, where they cannot
  share the box, swaps them with what is there, which waits in its place, Set aside. One sent for
  you (Send now, Compact, Retry, Cancel) leaves the box as it is.
- A path or "files changed" tapped while the side chat is open puts it away and opens Changes and
  files.
- Side chat in the session menu leaves the keys in the side chat's box, which, beside the
  conversation on a tablet, keeps clear of the home indicator, level with the conversation's.
  Quotes that do not fit above the message box fade at its edge, and removing one with the
  keyboard moves on to the next.
- A conversation opens without the code of Changes and files, which follows once it is up, and
  Settings without the usage page.

### Changes and files

- Search in files shows each hit where it is on its line, after a "…" when it is far along,
  marked in amber.
- A file's Quote and Copy sit in a row of their own under the file, so nothing scrolls beneath
  them.
- On a touch screen, search results and a step's file name are a finger tall, and the lowest row
  of Changes and files (Quote and Copy, Send now, or the bar saying Claude needs you) keeps clear
  of the home indicator, on a phone and beside the conversation on a tablet.
- Esc in a comment on a file gives the keys back to the file, as on a diff, so the next Esc closes
  the view.

### Security

- In a folder kept to your settings only, a `!` command runs git as Claude Code does there, with
  none of the repository's own programs (its file-system monitor, filters or hooks folder).
- Changes and files reads only regular files inside the folder it is asked about (the session's),
  links followed and checked. Downloads come as inert attachments. Search runs the ripgrep inside
  Claude Code with no config, an empty environment, no git and no links followed.
- Show all on a long `!` command reads the file Claude Code saved its output in by that file's
  name alone, from the session's own `tool-results` folder, or, for a record a branch copied, from
  that of the session its row says it came from, when the record's path names that session: a
  regular file reached through no link and with no other name.
- A page in Files runs its scripts only after Run, and again only after another Run once it has
  been rewritten; a page opened straight from another file never starts running.
- A side chat only reads, asks for nothing, and takes no `/` or `!` commands. A side chat branched
  from one of its questions is one too.
- Notification buttons go through the same checks as the page, and Allow is offered only for a
  command a notification shows in full: printable ASCII with one space between words, on one line,
  that fits two lines of the narrowest notification in its widest letters, and on Android, whose
  pop-up shows one line beside the buttons, that one line.

### Site, docs and project

- The demo's files have their text, and the files its conversations name open at the lines they
  name.
- The docs cover Changes and files, side chats, quotes, live `!` commands, the views and the
  usage page, and the coverage table moves side questions, views, quotes and Create PR to Yes.
- On a phone, the website leads with the two buttons and the install command, then shows the app
  in the same phone frame as on a computer, whole when you scroll, instead of a cropped card.
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

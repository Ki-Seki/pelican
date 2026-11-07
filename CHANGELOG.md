# Changelog

## 0.5.0

A terminal beside the conversation, quotes with notes, and every action where it is used, as in
Claude Desktop, with its keys; new sessions that start as Claude Code starts them, from its own
settings; and updates from Settings.

### Highlights

- **Terminal.** A Terminal tab beside Changes and Files runs your login shell on the computer, in
  the session's folder, with the environment Claude Code has there, as in Claude Desktop: `npm test`
  and `git status` see the files Claude is editing, and git by hand goes there. Ctrl+\` shows it, as
  in Desktop, and hides it again from inside it; Ctrl+Shift+\` opens a new one. Each terminal is a
  tab named after the program in front (zsh, npm, vim); + opens another, Open in terminal at the top
  of a folder in Files, or in a folder's menu there, opens one there, and End hangs the shown one
  up, as closing a window does, asking first while a program runs in it, also a job left in the
  background, but not for what your prompt keeps running for itself (powerlevel10k's gitstatusd,
  pure's worker). On a computer you type straight into it, with input methods, the emoji picker and
  dictation too, select to Quote (⇧⌘L) or Copy, and Ctrl and the wheel sets the text size. A
  right-click on it, or a long press on a phone, opens Claude Desktop's terminal menu: Quote and
  Copy what is selected, Paste, Select all and Clear terminal, with Select text on a phone. Clear
  terminal clears the screen and what scrolled off it, as `clear` does, on every page showing the
  terminal and in the computer's copy, so a reload, or another page, shows it cleared, and a program
  in front of the shell, such as vim or htop, draws its screen again, as after Ctrl+L. Its colors
  and font are Pelican's, light or dark, and a program that asks for its colors, as delta or vim
  does to pick a theme, gets them. A screen reader reads it.
- **The terminal on a phone.** A tap never raises the keyboard. You type in a line under the screen
  with your phone's own keyboard, so dictation and input methods such as Chinese pinyin work, two
  spaces stay two spaces (not the period a phone's keyboard makes of them), and Enter sends it;
  while you type, the screen takes the room of the header and tabs above it. A row of keys has what
  a phone lacks: esc, tab, ctrl, the arrows, `|` `~` `/` `-` and paste, a finger's size each,
  scrolling sideways on a narrow phone, and a key there sends what you typed first, so tab completes
  it. A line typed while the connection comes back stays until it can go. A full-screen program such
  as vim or htop gets every key as you type it, a password prompt hides what you type, a swipe
  scrolls back and ↓ comes back to the newest output, a pinch sets the size, and the menu's Select
  text opens the screen as text, to select from, quote or copy; Quote there opens the quote in
  place, with Add a note, Send now and Add, and the view says above the keys what waits for your
  next message. The keys, the tabs and the line are a finger's 44 px. A screen reader hears what a
  line printed.
- **A terminal keeps going.** It runs on when you close the page or your phone sleeps, and when you
  come back the page connects again by itself and shows the screen as it was, scrollback and a
  program such as vim, with its mouse, its cursor and the colors it set, included, without changing
  the size the shell has on another page. A shell that ends keeps its last screen, with Start again;
  so does one Pelican ended when it stopped, as all terminals end with Pelican. One unused for 12
  hours with nothing running in it closes on its own, and one nobody typed into that no page shows
  makes room when 10 run; with 10 in use, the Terminal tab lists those in other folders, to end one,
  asking first while a program runs in it. Its output comes over a connection of its own, so it
  never holds up an approval, and while a phone on a slow link catches up the shell waits for it, so
  Ctrl+C gets through at once.
- **Run in terminal and Quote.** A shell command in Claude's reply (a `bash`, `sh`, `zsh` or `fish`
  block) has Run in terminal, which asks, in place, before it runs it in a new terminal in the
  session's folder, pasted there, so its lines go in together. Only Claude's replies offer it, not a
  file or a tool's output, and only for a command with nothing hidden in it, as an approval reads
  one. Quote puts what you selected in the terminal, or its screen, above the message box as a quote
  from the terminal, as Claude Desktop attaches one, naming its tab, with a note if you add one; of
  a long one, its first 1,500 characters, as Desktop cuts any quote. Claude sees a terminal only
  that way. `!` commands go into the conversation as before.
- **Quotes with notes, as in Claude Desktop.** Select text in a reply, your prompt or a step's
  output for Desktop's two, in its order and words: Start a side chat (Send to side chat once one
  is open), which opens the side chat with the passage attached, and Quote. On a computer they sit
  above the selection and ↵ quotes; Quote opens Desktop's note box at the selection: ↵ adds the
  quote with your note, ⌘↵ sends it at once (a steer while Claude works), Esc lets it go, and a
  note half written survives a look at another session. ⇧⌘L quotes without a note. On a phone the
  pair docks just above the message box, clear of the system's menu; Quote puts the passage in the
  box with "Add a note", and the keyboard comes up only when you tap it. A left swipe on a
  paragraph, a prompt or a command quotes it.
- **What goes with your next message, in one place.** Quotes, quotes with notes and line comments
  wait above the message box as chips, each kind told apart at a glance. Click or tap one to read
  it whole, change its note, show it where it came from, or remove it. They are kept with your
  draft, and come back as they were when a message does not go.
- **Desktop's formats, both ways.** A quote with a note goes as Desktop's `<!-- reply -->` block,
  one without as an `<!-- attach -->` block (lines of a file with their path and lines, the
  terminal's with its tab), a line comment as "In `path` at line N:" with its code fenced, and
  Desktop's rules come along, ported from its own code: in a quote, keys and tokens masked, 1,500
  characters at most and an `@` that would mention a file defused; in a comment, Claude Code's own
  tags (`<system-reminder>`…) escaped, so code cannot speak as Claude Code; 99 quotes with a note in
  a message. Desktop and the CLI see Pelican's quotes as replies, and Pelican shows Desktop's,
  comments without code too, and its own older ones, as quiet quotes.
- **One list of actions for each thing, wherever you reach it.** A session, your prompt, Claude's
  reply, a step and a file's path each have one short list, in Claude Desktop's words and order,
  and every way in shows the same: on a computer a right-click, or ⋯ where the thing has one, with
  Desktop's keys faintly beside each action; on a phone a long press (half a second) on a session's
  row, your prompt, a step or a path, which raises the thing over a sheet of its actions. A long
  press on Claude's words stays your phone's own text selection.
- **The session's menu is its title.** The title with ▾ opens the one session menu: Rename · Pin ·
  Side chat · Fork · Copy resume command · Export · Transcript view (Normal, Thinking, Verbose) ·
  Archive · Delete, with the session's start and ID at its foot. A row of the list opens the same
  list, from its ⋯ (in place of its time, on hover), a right-click or a long press. Rename and
  Delete ask in a sheet of their own. On a phone the menu opens with Changes, Files and Terminal as
  tiles at its top.
- **Changes, Files and Terminal in the header.** On a computer three quiet buttons, Changes with the
  lines changed ("+31 −2", counted as Claude Code's `/diff` counts them: on a branch with commits
  beyond where it split from the default branch, those commits and what is not committed yet, else
  what is not committed), Files and Terminal, each with its name and key in its tooltip, each
  showing its tab or hiding the pane while it shows it (Changes, asked for, shows Changes in a
  folder git does not track too, and says why it is empty); on a phone one button, the lines changed
  or a folder.
- **Side chats, kept with their session.** A session's side chats are the computer's to list, not
  one browser tab's, so your phone and your computer show the same ones, also after a reload. The
  side chat opens on the latest, called by its first question ("Side chat · Why not a class on
  html?"), and its name's ▾ lists the session's others, the latest first, then New side chat. Start
  a side chat, on a selection, a reply or a command's output, starts a new one from the session as
  it is now, the passage going with your question as Claude Desktop attaches one and quoted above
  it; while one is open, Send to side chat goes to it, and so does `/btw` with a question. On a
  computer it shares the column beside the conversation with Changes, Files and the Terminal: from
  1280px it sits under the one open, a handle between them sharing the height, which this browser
  remembers; below that, where there is room for one, the one asked for last shows and the other
  waits behind it until it closes. On a phone it is a sheet that Back closes. Picked in the session
  list or found with ⌘K, a side chat opens as its session's side chat, not as a copy of the session.
- **Context, by Send.** The context ring sits in the message box's row, as in Desktop, and opens
  Context: how full the window is, with Compact, what the whole session used, your plan's limits,
  and Usage and activity. On a phone it shows once a turn has run, faint and without its number
  below 60%.
- **The message box's +.** Add files or photos (⌘U), Commands, Files and agents, Shell command, and
  the session's MCP servers ("1 of 2 on"), which have a sheet of their own, also with `/mcp`; a line
  above the box says when one fails while Claude runs.
- **While Claude works, Send and its other way side by side.** Send does what Settings › While
  Claude works, Send says, Sends now (Claude reads it at its next step) or Queues for later (it goes
  when the turn ends), and a quiet line above what you typed says so and offers the other as a
  button of its own, Queue for later or Send now, a finger's 44 px on a phone; on a computer where
  Enter sends, ⌘↵ (Ctrl+Enter) is that other way, as Desktop's ⌘↵ queues for later. Stop never hides
  while Claude works: alone while the box is empty, quiet beside Send once you type.
- **One list of commands, behind / and ⌘K.** This session's actions by Claude Code's names (`/btw`,
  `/branch`, `/rewind`, `/rename`, `/export`, `/diff`, `/context`, `/mcp`, `/model`, `/tasks`…),
  then Pelican's (Pin, Archive, Files, Terminal, New session, Settings…), then Claude Code's
  commands and skills. A command of your own takes its name from one of Pelican's. On a computer ⌘K
  opens the list as a command menu, where typing a session's name finds it too; ⇧⌘K searches
  sessions.
- **Your prompt and Claude's reply carry their own.** Your prompt: a tap on a phone shows Copy ·
  Rewind to here · Fork from here under it; with a pointer they sit beside it, on hover, adding no
  height. Claude's reply: Copy · ⋯ · the time under it, always on a phone, and on a computer Copy ·
  Fork from here · ⋯ · the model and the time, in room kept for them; its ⋯ has Copy message as
  Markdown, Start a side chat, Quote message, Rewind to here and Fork from here, the turn's figures
  at its foot. A right-click puts what was clicked first: a selection's Copy and Quote selection, a
  code block's Copy code, a path's own menu; links and pictures keep the browser's.
- **Rewind to here, as in Claude Code and Claude Desktop.** On your prompt, or on Claude's reply
  (its turn's prompt), it goes back to before that message: the code, the conversation, or both.
  Where Claude changed files after it, Desktop's dialog asks, "Rewind to this message?", with its
  three choices, Code and conversation (first), Conversation only and Code only, which files go
  back and how many lines change, and its words: "Changes made through shell commands aren't
  reverted. Commits stay in place." Where nothing changed, there is nothing to choose, and one tap
  rewinds, as in Desktop. The files go back from Claude Code's own copies of them, as `/rewind`'s
  Restore code does. The conversation goes back as the CLI's Restore conversation does: the
  session's Claude starts again from just before the message, and the message's words, its quotes
  and its pictures and files go back in the message box, to change and send. A "Rewound here"
  marker sits at the cut, with Undo rewind, which brings the messages back (the files stay as they
  are) until you send your next message; it takes the words back out of the box while they are as
  the rewind put them. Code and conversation is all or nothing: code that cannot go back leaves the
  conversation whole. Not while Claude works, and, while another app has the session open, the
  code alone, as Desktop does; the conversation's first message, and one before a compaction, can
  go back in code only.
- **`/rewind`, as Claude Code names it** (also `/checkpoint` and `/undo`), and Rewind to an earlier
  message in ⌘K list the conversation's prompts, oldest first; picking one is its Rewind to here.
  A turn in Changes ends with its prompt's Rewind to here.
- **Fork from here.** On your prompt, a new session up to just before it, with its words, its
  quotes, and its pictures and files waiting in the new session's box; on Claude's reply, a new
  session up to the end of it.
- **Changes, as in Claude Desktop.** Show: All changes vs main, by Claude Code's `/diff` (the branch
  since it split from the default branch, its commits and what is not committed yet, the files not
  committed first; else what is not committed), then Uncommitted changes where that differs, and the
  turns under their own heading. At its foot, Commit changes and Create PR ▾, with Create draft PR
  under its ▾, remembered, as in Desktop, and no Push (Desktop has none; Create PR pushes). A tap
  sends Desktop's own request at once, word for word, so Claude Code reads the same request
  whichever app sent it; while Claude works it waits for the end of the turn as a queued message,
  never steered into the work at hand, whatever Settings says for what you type, and its button says
  it is queued, with Take back, which takes it out of the queue. ⌘-click (Ctrl-click), or a long
  press on a phone, puts it in the message box first, to read and change. Create PR shows in the
  conversation as `/create-pr`, as in Desktop; Create PR is offered on a branch other than the
  default one, where origin is on GitHub, or where there is no remote at all, for which Desktop's
  request has Claude set one up first. The pull request Claude names in Desktop's `<pr-created>` tag
  is a card, with View PR, and where gh on the computer is installed and signed in, what GitHub says
  of it now: its title, open, a draft, merged or closed, its branches and its checks, read again
  while they run. A file's row has its path's menu.
- **Lines of a file, and of a diff.** A tap or a click picks a line, Shift-click picks up to
  another, and on a phone a long press on a line, then a drag, picks the lines it goes over: a bar
  under them has Copy · Quote · Add comment, as a right-click on them does, and ⇧⌘L quotes them. A
  line number turns into Desktop's + under a pointer, a comment on that line at once. Comments use
  Desktop's box at the line, Cancel · Send to Claude · Add comment (↵ adds, ⌘↵ sends to Claude, with
  everything that waits), on one line or a few in a row, "at lines 10-12" as Desktop writes them; on
  a diff, removed lines alone are its "before changes". A diff's selection and right-click offer
  Copy and Add comment. A file's ⋯ has its path's menu, Attach as context included. On a phone,
  Quote in Changes, Files or the Terminal opens in place as a sheet, with Add a note, Send now and
  Add, and the view's foot then says what waits; beside the conversation the quote waits above the
  box at once, as Desktop's Attach as context does.
- **Steps and paths.** A command step has Copy command · Run in terminal · Copy output · Start a
  side chat · Quote output; a file step and a path in a reply have Desktop's path menu: Attach as
  context · Copy ▸ (Absolute path, Relative path, Filename) · Open in Changes · Open in Files ·
  Download file, a folder Open in terminal. A `!` command in the conversation has a command step's
  list, from a long press, a right-click or ⋯; Run in terminal, there and on a step, is offered for
  a command that shows all it holds, as a code block's is. The rows of Files and of Changes have
  their path's menu too, a folder's with Open in terminal.
- **What runs in the background, "1 in background".** Commands, agents and workflows Claude left
  running, and the checks it stays running for, read "2 in background" in the session list and under
  the title. ⌃B, as in Claude Desktop (Ctrl+Alt+B off a Mac, where Ctrl+B shows and hides the
  session list), or `/tasks`, as Claude Code names it, opens their list above the message box with
  the keys in it, and says so when nothing runs. A command has Output and Stop; an agent's row, and
  a workflow's, leads to its card, where a workflow's one Stop is.
- **Claude's to-do list, one line.** In the conversation each of Claude's task lists is a step,
  "Tasks · 1 of 4 done", which opens to the list as it was then; the bar above the message box is
  its live view, the task under way first.
- **Claude's questions by number.** On a computer 1 to 9 pick an answer, as in Claude Desktop, the
  number faint beside each option: the card takes the keys as it comes, unless you are typing
  something, a number picks for the question the keys are in, or the first not answered yet, and a
  letter starts that question's own answer under Other.
- **The session list hides, and floats.** On a computer its button (or ⌘B, as in Desktop) hides it,
  remembered in this browser, and the conversation takes the whole width; pointing at the window's
  left edge or the button brings it over the conversation until the pointer leaves, a session is
  picked or Esc. Between 1024 and 1279px a pane beside the conversation hides it the same way, and
  ⌘B brings it back.
- **Back on a phone closes what is open.** Android's Back, and the browser's, closes the sheet or
  menu that is open, and goes no further.
- **Update from Settings.** Pelican asks npm's registry for a newer version once a day, and when
  Settings opens, and says so there, quietly, with what changed, from the new version's
  CHANGELOG.md; offline it says nothing. Where npm installed Pelican into its global folder, Update
  installs that very version: first into a folder of its own, where Pelican checks that it starts,
  then over your install, with the same prefix and npm's integrity checks, and Pelican starts again,
  through launchd or systemd when it runs as a service, in its own place when it runs in a terminal;
  pages reconnect by themselves on the new version. While anything runs that the restart would end
  (Claude working or waiting for you, background agents, workflows and commands, a terminal's
  program, a `!` command), Settings lists it first, with Update now and Update when idle, which
  waits until nothing has run for a minute, and can be cancelled. Transcripts, files, pins, settings
  and drafts stay. Run by npx, from a clone, from another prefix than npm's (as a script of your own
  may keep it), by pnpm, Yarn, Bun or Volta, or from a folder root owns, Settings shows the command
  to run instead, and why. If anything fails, the running version goes on, and Settings says what
  failed.

### Changes in behavior

- **New sessions start as Claude Code starts them.** Their model, effort, fast mode, Ultracode and
  permission mode come from Claude Code's settings, the files the terminal and Claude Desktop read:
  yours (`~/.claude/settings.json`, or the one in `CLAUDE_CONFIG_DIR`), the folder's
  `.claude/settings.json` and `.claude/settings.local.json` once it is trusted (until then a new
  session's model and mode sheets say they wait, and its first message asks), and managed
  settings, each over the one before, as in Claude Code 2.1.318. Pelican keeps no defaults of its
  own: its High effort is gone, and so are the picks each browser kept under Settings; those kept
  before 0.5.0 are no longer read. A model starts with the effort Claude Code keeps for it
  (`/effort` keeps one per model), else Claude Code's own for it, and with fast mode where your
  settings turn it on (not with `fastModePerSessionOptIn`). Ultracode is on only where a settings
  file turns it on, as in Claude Code, whose commands never save it. Where no file names a mode, a
  session starts in Auto, as the terminal now does ("Auto mode is now Claude Code's default
  permission mode"), or in Manual on a model without Auto or where settings turn Auto off; Auto and
  Bypass count only from your own or managed settings, never from a folder's (a folder's Bypass
  starts in Manual), as in Claude Code. Where your own or managed settings make Bypass the default,
  new sessions start in it, as Claude Code's do, and Settings and the new session's mode sheet say
  so; a fork, Fork from here or a `/clear` of a session in Bypass starts as a new session would.
  Settings › New sessions start with shows all this and where each value comes from, and a new
  session's model and mode sheets say when the folder's or managed settings decide.
- **Settings writes Claude Code's settings, as `/model` does.** A model, an effort, fast mode or a
  mode picked under Settings › New sessions start with is saved in your Claude Code user settings,
  as `/model`, `/effort`, `/fast` and `/config` save it, so new sessions in the terminal and in
  Pelican, on this computer or your phone, start the same way: `model`, the model's
  `modelSettings.<model>.effortLevel`, `fastMode` and `permissions.defaultMode`. Max effort and
  Ultracode are not offered there, as Claude Code keeps neither as a default, and Bypass never is.
  A model, an effort or fast mode picked in a session's model sheet is saved too, as `/model`,
  `/effort` and `/fast` save it in the terminal; Max effort, Ultracode and the mode stay with the
  session. A settings file that is not valid JSON is left as it is, and Settings says so; one
  reached through links, also a link to a link, is written where they lead, every link kept. A
  running session keeps the model, effort and mode it started with, as in Claude Code.
- A session's effort shows as Claude Code applies it, its own default for the model included.
- Keys are Claude Desktop's, as it takes them in a browser: ⌘K (Ctrl+K) opens the command menu and
  ⇧⌘K (Ctrl+Shift+K) searches sessions, which ⌘K did before; ⇧⌘O starts a session, ⇧⌘, opens
  Settings, ⌘B shows or hides the session list; ⌥⌘R renames the open session, ⌥⌘O forks it and ⌥⌘A
  archives it, ⌃B lists what runs in the background (Ctrl+Alt+B off a Mac); ⌃⇧D shows Changes, ⇧⌘F
  Files and ⌃\` the terminal, on a Mac too; ⌘U adds files, ⇧⌘I opens the model, ⇧⌘E its effort, ⌥⌘F
  turns fast mode on or off and ⌥⌘M opens the mode; while Claude works, ⌘↵ is the other way to send,
  Queue for later or Send now, where Enter sends; 1 to 9 pick an answer to Claude's question. ⌘, and
  ⌘⇧D work as well where a browser passes them on, and keys a browser keeps for itself are left to
  it. Off a Mac, Ctrl takes ⌘'s place.
- The list of keys (⌘/ or Ctrl+/) is Desktop's: in its parts (General, This session, Panes, Message
  box, Quotes and comments, Questions), wide on a computer, naming only the keys that work, every
  one of them, ⌘↵ by what it does with Settings' choice.
- While Claude works, the Steer and Queue button beside Send, which named the way a message would
  go, is gone: Send goes the way Settings says, and the line above what you typed offers the other
  (Queue for later or Send now), as a button. Stop no longer gives way to Send once you type: both
  show. Settings calls the choice While Claude works, Send: Sends now, or Queues for later (was
  Messages sent while Claude works: Steer or Queue), and the default view Default transcript view
  (was Sessions open in). Its Account is the account and the plan on one line; the plan's limits are
  in Usage and activity and in a session's Context. A row of choices, there and in other sheets, is
  a light track with the one picked raised, 44 px tall on a phone.
- Claude's to-do list shows as one step line, "Tasks · 1 of 4 done", instead of a card each time the
  list is new, changes or is done.
- Work Claude left running between turns reads "1 in background", not "1 task", in the list and
  under the title. A workflow's row above the message box has no Stop of its own: it leads to the
  workflow's card, where Stop is.
- The tip shown once in a browser for each way another app has the session (open, working or
  waiting there) is gone: the status says it, and so does the empty message box.
- Commit and Create PR send Claude Desktop's own requests at once, from the foot of Changes, instead
  of putting a request of Pelican's in the message box (⌘-click or a long press still does), and
  while Claude works wait for the end of the turn, queued, whatever Settings says; Push is gone, as
  in Desktop. Changes opens on All changes, by `/diff`'s rule, instead of what is not committed,
  which is Uncommitted changes now; Since main is All changes, and the turns are listed without
  their T1, T2.
- A tap on a line of a file or a diff picks it, for its bar, instead of opening a comment; on a diff
  it still opens one. A file's Mention is its ⋯'s Attach as context, which attaches the file as
  Desktop does (`@"path"`). The terminal's long press opens its menu; the screen as text is its
  Select text.
- Line comments go to Claude as Claude Desktop sends them, and wait as chips above the message box
  with your quotes; the line saying how many go with your next message is gone. Send now in Changes
  and files sends everything that waits. Inside Changes and files on a phone, where the box is out
  of sight, its foot says what waits; beside the conversation it is Send now alone.
- Quotes and line comments kept by an earlier version move into the new list once, notes and all.
- A session called by a prompt that quotes is called by its words, not its markers, and so is a
  queued message.
- On a phone, a session's row takes the swipe a paragraph takes to be quoted, with its own Pin and
  Archive as before: a short one shows them, a full one archives with Undo, none goes right or
  starts at the screen's edge, and none is taken while text is selected. On a computer the row's
  hover Pin and Archive buttons are gone: they are in its ⋯, which shows in place of its time.
- The header's ⋯ is gone, and so is the meter beside it: the title's ▾ opens the session's menu, and
  the context ring is by Send. The session menu's words are Desktop's: Fork (was Branch), Copy
  resume command (was Continue in a terminal), Export (was Export as Markdown). Its MCP servers
  moved to the message box's +, and its details to where each is used: the folder and branch under
  the title, the session's totals in Context, the last turn's figures in its reply's ⋯, its start
  and ID at the menu's foot. Archiving the open session from its menu offers Undo, as from the list.
- Claude's reply no longer shows how long a turn took, its tokens and its cost under it: they are in
  its ⋯.
- Editing a prompt is Rewind to here, which puts its words back in the box, or Fork from here, which
  puts them in a new session's, as in Claude Desktop and the CLI: Edit, and its box in place of the
  prompt, are gone. A prompt's Rewind, and a turn's Rewind code in Changes, which put files back,
  are Rewind to here, whose Code only does that.
- The message box's paperclip is its +, where Add files or photos is.
- ⌃⇧D shows Changes, and hides the pane while it shows them; the pane's other tabs have their own
  buttons and keys. Below 1280px, where a pane beside the conversation hides the session list, the
  way back to the list is its button in the header, not ‹, and ⇧⌘K brings it over the conversation
  to search.
- Export as Markdown shows a prompt's quotes and their notes, comments on lines and attached files
  as the conversation does, Claude Desktop's and Pelican's alike, never their markers.
- The side chat no longer puts Changes and files away beside the conversation from 1280px: both
  show, one above the other, and a file or a turn's changes opened from an answer opens above it.
  Its New is New side chat, in its name's ▾; its sheet on a phone closes with ×, as it does beside
  the conversation, or Back.
- The session list (with its options showing side chats) and ⌘K call each side chat by its first
  question, each a row of its own, no longer all "Side chat", folded into one.

### Fixes

- An agent Claude left working in the background shows as Claude Code and Claude Desktop show one:
  under its step, Running in background with its steps, its time and what it is doing, then
  Finished, Failed or Stopped in background. Opened, its steps are read again every few seconds
  while it runs (they stayed as they were when first opened), with Stop in a session Pelican runs;
  once Claude Code says it ended, what it returned, or why it failed, is in its card, and the line
  where Claude heard of its end leads there instead of repeating it. It is a step of its own, never
  folded away among the others. What Claude Code tells Claude when it starts such an agent ("Async
  agent launched successfully…", its id and its output file) no longer shows, nor its pointer to a
  report the agent handed back, which shows in its place; a report handed back while Claude worked
  no longer shows as a message you sent.
- On a phone, a tap near the end of the conversation lands on what was tapped: the conversation no
  longer moves under the lifting finger to reach its end, unless something arrived while the finger
  was down, as the last reply's actions, now always under it, are tapped there.
- A session opened while its Claude waits, started for a rewind or a `!` command rather than a
  message, shows its own model, effort and mode, and the next message keeps them, instead of
  switching to Claude Code's defaults.
- A session started in a folder reached through a link (on a Mac, `/tmp` is `/private/tmp`) runs in
  the folder itself, as Claude Code records it, so its conversation, Changes and Terminal name one
  folder alike: before, a reload could show its terminal as no longer running, beside a second one
  started under the folder's other name.

### Security

- A pull request's card asks GitHub what it says of it now with `gh pr view <address> --json …`, the
  GitHub CLI as you, only where it is installed and signed in, only for an address of the form
  `https://github.com/<owner>/<repo>/pull/<n>` that Claude named in Desktop's `<pr-created>` tag,
  from no repository, with no prompt and within 10 seconds, at most four at once and at most every
  half minute for a pull request, however many cards pages show (a reply has at most five); it
  changes nothing. Only such an address's card names its repository as GitHub's: any other's names
  its host first, as the browser would open it, so a host made to look like GitHub's
  (`github-com.pr-review.example`) does not pass for it. Pelican runs no git that changes anything:
  Commit changes and Create PR are requests to Claude, which runs git and gh under your permission
  rules. The demo asks nothing of GitHub.
- Updating from Settings takes a request from Pelican's own page, signed in, as every change does,
  and never in either demo; it installs nothing but pelican-cc, at the newest version npm's registry
  names, which the request must name exactly, with npm's integrity checks and no package scripts,
  and only where npm itself installed Pelican in its global folder, which this account can write to.
  Pelican never runs sudo. SECURITY.md says what it runs, and when.
- A terminal opens only for a signed-in browser on Pelican's own page, under a host name Pelican
  answers to, as everything else does, and runs in a folder as Claude Code does: a folder nobody
  trusted that brings programs is asked about first, and in one kept to your settings only, git runs
  none of the repository's programs. The shell gets none of Pelican's settings (`PELICAN_*`), npm's
  (`npm_*`), Claude Code's mark (`CLAUDECODE`) or the Agent SDK's, so `claude` starts there as in
  any terminal. At most 10 terminals run at once, each on up to 8 pages; nothing of them is written
  to disk. The demo has none, and `pelican --no-terminal` (also for `pelican service install`)
  starts Pelican without them.
- Clear terminal sends the shell nothing: Pelican clears its copy of the screen and the pages, then
  tells the program in front of the shell, found with `ps` as End's question finds it, that the
  window changed (SIGWINCH, as a resize does), and where that program is not this account's to
  signal (`sudo vim`), changes the terminal's size by a row and back. Ctrl+L, which such programs
  redraw on, would be a key typed into them: vim's insert mode takes it as a form feed.
- A paste into a terminal, and the phone's line, leave out control characters, as xterm, kitty
  and Windows Terminal do: text a web page put on the clipboard as you copied from it cannot end
  the shell's paste early and run without Enter.
- What a terminal keeps of its screen is bounded, on the computer and on a page: 2,000 lines, at
  most 11 combining marks on a character and 14 UTF-16 code units in a cell (six of the marks past
  U+FFFF, which take two each), whatever a program prints between them, so a cell stays one string
  of about 40 bytes and a 500x300 terminal full of Zalgo text takes about 50 MB (with 16 marks a
  cell it took 362 MB), while a flag of England, Scotland or Wales, seven code points in one cell,
  still draws whole; the latest 2,048 links (the computer keeps none), no title, and at most 20
  lines' worth of output for a screen reader to read out, also of output with no line feed in it; a
  sequence that repeats a character, scrolls, inserts or deletes lines or moves by tab stops does so
  at most a screen's worth of times (REP a line's), however large a count it gives, and the
  computer's copy takes output in a little at a time; so no output grows Pelican's memory, or a
  page's, without bound, or holds the rest of Pelican up for more than a moment; and output xterm
  throws on stops neither Pelican nor a page's screen.
- A new token or password (`pelican token --reset`, `pelican password`) signs out what a browser
  has open too: its terminals and its live updates close within a second, and nothing it sends
  after reaches a shell. Before, a page that had a connection open kept it.
- A folder nobody trusted whose Claude Code settings pick a model, an effort, fast mode, Ultracode
  or a mode, Plan too, is asked about before its first session, with those listed beside its
  programs: a folder's settings count only once it is trusted, as in Claude Code. Before, they
  applied with no question where the folder brought nothing else, so a cloned repository could turn
  on Ultracode and fast mode.
- A branch of a side chat is a side chat of its own, marked as one: it stays read-only, with the
  reading tools alone and no MCP servers, when the side chat it came from is deleted, cleaned up by
  Claude Code after `cleanupPeriodDays`, or more than eight branches back. Before, it then resumed
  as a session with every tool, its MCP servers and its mode, and could be rewound.
- Signing out signs that browser out on the computer too: its cookie, and every renewal of it, is
  refused until it would have expired, also after Pelican restarts, and its terminals and live
  updates close at once, in every tab. Before, only the browser forgot the cookie: a terminal open
  in another tab kept taking keys, and the cookie, copied, still signed in.
- Run in terminal reads a command as an approval does: it is offered, and the server runs it, only
  for one with no control character a shell takes as a key and nothing an approval would write out,
  such as a character that hides or turns text around, or a space other than a plain one where a
  shell reads it as part of a word.
- The terminal's native part, `@lydell/node-pty`, pinned to one version, is Microsoft's node-pty,
  the one VS Code uses, file for file: CI checks every platform's against Microsoft's own package,
  the few lines of @lydell's own against those read for this version, that this version pins each
  platform's package to its own, so an install from npm gets the files CI checked, and that none of
  it runs anything as npm installs it. It is optional: where it cannot load, such as on Alpine
  (musl) or after an install with `--omit=optional`, the terminal says why, and `!` commands work as
  before.

### Site, docs and project

- The docs say how to update from Settings: what Pelican asks npm's registry and when, which
  installs update themselves, the command for the others, what an update ends, and how Pelican
  starts again.
- The docs describe where every action is: each thing's list and its ways in, the session menu,
  the header's buttons, Context, the message box's +, the command menu, the keys, the session list
  hiding and floating, and Back on a phone.
- The docs describe Rewind to here, Undo rewind and `/rewind`, and the coverage table has Rewind
  with the code and the conversation, without Summarize from here.
- The demo and the site's live demo act out Rewind to here, Undo rewind, Fork and Fork from here in
  the page, and the smoke test walks them, on a computer and a phone.
- The browser smoke test walks the ways in, in the app and the site's live demo: on a computer a
  row's ⋯ and right-click, the title's menu, the message box's + and /, ⌘K, a prompt's, a reply's,
  a step's and a path's menus, a link's right-click left to the browser, ⌘/ and the session list
  hiding and floating; on a phone a row's long press, the title's sheet and its tiles, a prompt's
  tap and long press, a reply's row, a step's long press and +, Back closing each.
- The docs describe the terminal: the tab and its keys, on a computer and a phone, where it runs,
  what it keeps and when it ends, `--no-terminal`, and its security. The coverage table has "A
  terminal beside the conversation" as done.
- The demo and the site's live demo show the Terminal tab, which says calmly that nothing runs
  there.
- The docs describe side chats as they are kept now: by the computer, each called by its first
  question, under Changes, Files or the Terminal from 1280px, in their place below that, and a
  sheet on a phone. The demo and the site's live demo have two side chats on the dark theme
  session, the latest asked with a passage of Claude's reply, and the smoke test walks them on a
  computer and a phone, in the app and the site's live demo.
- The docs say how Changes, Files and the Terminal work as Claude Desktop's do, Commit changes and
  Create PR queued while Claude works, and Clear terminal on every page; how an agent Claude left
  working in the background shows; and how, while Claude works, Send and its other way sit side by
  side, what runs in the background is listed (⌃B, `/tasks`), the to-do list is a line and 1 to 9
  answer a question. The coverage table has Send now or queue for later, the task list as a line,
  background tasks with ⌃B and `/tasks`, and a pull request's status, Partly, as the card shows it.
- The website's highlights say what Pelican does now, the terminal and quotes with notes among them,
  and Settings' updates; its pictures and the README's, and the README's tour, are of 0.5.0. The
  social card stays as uploaded, and the screenshot script draws one only when asked (`--og`).
- The demo and the site's live demo have a session with two agents Claude left working in the
  background, one finished, its report in its card, one at work, which finishes a while after the
  session is opened, or stops when asked; "Fix the flaky login test" runs a `!` command and ends
  with Commit changes and Create PR sent and the pull request's card, its repository's remote a
  made-up one on GitHub that nothing contacts, and a request sent in either demo is acted out as
  Claude would carry it out; and once the dark theme's waiting edit is allowed, Claude asks where
  the theme's choice is kept, to answer with a tap, or 1 to 9 on a computer.
- The browser smoke test walks Changes' Show, Commit changes and Create PR, a `!` command's list,
  picked lines with Copy, Quote and Add comment, the quote in place on a phone and Desktop's comment
  box, on a computer and a phone, in the app and the site's live demo; and while Claude works,
  Send's other way, a finger's size on a phone, with Stop beside Send, Claude's question once the
  waiting edit is allowed, picked and answered, and "1 in background" with ⌃B.
- CONTRIBUTING.md maps where 0.5.0's parts are: actions and menus, keys, commands, presses, quotes
  and comments, requests, Rewind, what new sessions start with, a pull request's card and updates.
- THIRD_PARTY_NOTICES names the terminal's xterm.js packages, built into the web app and the
  server; the PTY is installed as a package of its own, with its license, as the Agent SDK is.
- The tests of Back closing a sheet wait for the step back to land, which on a busy computer takes
  longer than the 20 ms they gave it.

## 0.4.1

Pinned sessions and the files Claude sends you, as in Claude Desktop; approvals that show what a
command hides; and what the reviews of 0.4.0 left.

### Highlights

- **Pinned sessions, as in Claude Desktop.** On a phone, a short swipe left on a row shows Pin
  (Unpin on a pinned row) beside Archive, Archive at the edge as in Mail; a swipe all the way across
  archives, with Undo, as before. On a computer the pin sits beside Archive when you point at a row,
  and Pin is in the session menu; in the list, Undo shows for five seconds. A row takes no swipe
  right, which is Safari's Back, nor one that starts at the very edge of the screen. Pinned sessions
  lead the list under Pinned, grouped by time or by project, and under their project's filter, each
  with its status (Working, Needs you, tasks) and its earlier runs. Pins are Pelican's own, kept on
  the computer for all your browsers: a session pinned in Claude Desktop is not pinned here, and
  Desktop's pins are left alone. Archiving a session unpins it.
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

### Fixes

- `npm install -g pelican-cc` installs Claude Code for this computer alone, about 150 MB to
  download: from the package's npm-shrinkwrap.json, npm installed it for all eight platforms, 1.2 GB
  to download and 2.6 GB on disk, and in a project Pelican's own build and test tools too. The
  packages Pelican's server uses are built into it instead, as CI tested them, and the Agent SDK,
  with the Claude Code it brings, stays pinned to one version. The package now ships
  `THIRD_PARTY_NOTICES`: each package built into the server and the web app, with its version and
  license in full, and, for web-push, which is under the MPL 2.0, that its source is its npm
  package. It credits esbuild for the helper code it writes into the server, gives what rolldown's
  runtime takes from others, and quotes the notices of others that files built in carry at their
  top, such as path-browserify's in code of vfile's, which minifying leaves out. The build writes it
  from what it puts in the bundles, and fails if one is missing.
- A file Claude sent that is no longer there, as many are in older sessions, says "No longer on
  this computer" before you tap anything, the same for every type, with its name and size and
  nothing to tap; one past 200 MB says it is larger than Pelican serves, and a text file that large
  still shows its start. A browser tab that opens one anyway says so in a page, not in JSON.
- A character in a sent file's name that hides or turns text around shows as ⟨U+202E⟩, with the
  approval's warning, on its card, in the step that sends it and in the name it is saved under: a
  script named to read as a picture no longer does. A screenshot keeps the name macOS gave it.
- Files Claude sent in Claude Desktop show from Claude Code's record of what it delivered, so one
  Claude named by a relative path shows too; a file Claude Code did not deliver never shows.
- An SVG file Claude writes shows in its own colors and fonts, as a browser shows it: the visuals'
  styles repainted its text and boxes (a yellow box near-white, a white label near-black). A sent
  picture too small for the download button in its corner has the button beside it.
- A download, of a file Claude sent or from Changes and files, stops at the size the file had when
  you asked for it: one that grew meanwhile, such as a log still being written, went on past the
  size it had announced, and past the 200 MB limit. One cut short meanwhile breaks the download off.
- A file whose extension names what every JavaScript object has, such as `.constructor`, opens as a
  file: sent by Claude it failed with a server error, in Changes and files it showed as a broken
  picture, and as an upload it would not open.
- On a computer, a row's buttons cut none of its words: the words under them fade out, and in a
  compact row the project and time make room for them. From the keyboard, Pin, Unpin and Archive
  leave focus on the session's row where it went, or on the next row when it leaves the list, and
  Undo brings focus back to it; Archive used to drop it to the page.
- A compact row keeps a date on one line ("Oct 25", not "Oct" over "25"), and grouped by time the
  list's headings say what they hold, Previous 7 days and Previous 30 days: "This month" held
  October's sessions on 6 November.
- A session archived in 0.4.0 while pinned in 0.4.1 comes back unpinned when you unarchive it.
- A step Claude is still writing keeps its icon and its verb at their size beside a long command.
- A conversation shows its day above its first message too, and above the first prompt of each new
  day, as Claude Desktop does: Today, Yesterday, or the weekday and date.
- A `!` command that is a command in backquotes, such as `` `grep x f` ``, takes exit code 1 as
  an answer, as Claude Code does, not as a failure: where a command would start, Pelican reads a
  backquote as Claude Code's parser does, after `;`, `|`, `if` or an assignment too.
- Beside the conversation on a computer, a file's Quote and Copy row ends level with Send now and
  the message boxes; it sat 2px lower.
- An Agent call's steps come a page at a time, the newest first, with Show earlier, as a workflow
  agent's do: a long subagent's transcript, tens of megabytes, no longer reaches the phone whole. A
  page with no step in it, such as a long answer at the end, is read past, so the card counts the
  steps it shows, never "Last 0 steps", and Show earlier always brings at least one more; a page
  that cannot be read says why, and Show earlier asks again. A step too large to show says what was
  left out of it, and the transcript is read only from the session's own folder.
- Behind a tunnel or a proxy that cannot reach Pelican, a 502, 503 or 504 shows the quiet "Can't
  reach" line, which keeps trying, instead of the error; a conversation that could not load then
  loads once the computer is in reach again, also while the live connection stayed up.
- Export as Markdown reads as the conversation does, but for a reply's single line breaks, which a
  Markdown file joins, as GitHub does. A prompt is text, as you typed it: none of its Markdown takes
  effect, so a ``` it opens no longer swallows the rest of the file, nor makes a line of `:--` a
  table, and its quotes are quotes, a quote from a file its lines as code. A reply keeps to itself
  in any reader (GitHub, VS Code's preview, the spec's own): a heading in it sits under the
  speakers' (`##` becomes `####`), so none passes for "You" or "Claude"; its HTML is text, as the
  conversation shows it, so none hides the turns after it; a picture is a link that names its site,
  never loaded when the file is read; its links by reference are written with their addresses and
  its footnotes under labels of its own, so two replies' `[^1]` are two footnotes and no reply
  changes where another's links lead or what its footnotes say; and a code block it leaves open ends
  with it. Where readers part ways on a reply (an autolink with a character one of them takes, an
  address with a control character, `ftp://`, a table VS Code's preview finds under a fence or a
  heading), it is written so that they read it alike. The files Claude sent are named under their
  step, with the words Claude sent with them. An address that starts with http://, https://, ftp://
  or www., and an email, in prompts and Claude Code's notes stay text, as code, where a reader would
  link them. A text past 60,000 characters ends with "…", as the conversation shows it. The folder
  is named as the app names it, from your home folder (`~/code/acme-web`), and a file a step reads,
  edits or writes from the session's folder (`src/styles/theme.css`).

### Security

- An approval shows the characters that show as nothing or turn text around, as `⟨U+E0078⟩`, and
  warns of them: besides the zero-width and direction-changing ones, tags, a variation selector
  after a letter or a run of them, fillers, soft hyphens, a carriage return, a code point not
  assigned yet and the others Chrome draws as nothing or as a blank, so a command can no longer read
  as `./build.sh` and run another file. The trust sheet, the line saying why Claude Code asks and a
  sent file's name show them the same way.
- A space other than a plain one in a command shows as `⟨U+00A0⟩`, with the warning, unless Pelican
  finds it in quotes, a heredoc's body or a comment: a shell takes it as part of a word, so `echo
  done⟨U+00A0⟩# ; curl … | sh` read as a comment and ran curl, and `LC_ALL=C⟨U+00A0⟩cat ./setup.sh`
  ran ./setup.sh. Pelican reads the command as bash, zsh, dash and macOS's bash 3.2 do, and the
  scripts it hands a new shell: after `bash -c` or `ssh`, in a heredoc or pipe into `sh`, a script
  it writes with a redirection or `tee` and then runs by its path, or by its name once it makes it a
  program, or that runs on its own as a git hook or as a file a shell reads as it starts (what
  BASH_ENV, ENV or `--rcfile` names, a .zshenv). A command that uses what can run text later in its
  own shell has every such space show, however the text is made (split across quotes, by a variable
  or an escape): `eval`, `source`, `trap`, an alias in any form (after `command` or `builtin`, or
  named by a variable), `read`, `declare`, `let`, `unset`, zsh's `set -A` and its functions array,
  bash's `BASH_ALIASES`, a parameter flag such as zsh's `(e)` and `$~x` or bash's `@P`, `setopt` or
  `set -o` with an option that changes how text reads, `test` or `[` with an operator a variable may
  give (`-v`), `at` and `crontab`, a command whose name Pelican does not know, arithmetic on a
  variable the command sets to anything but a number, and the like, each by its name in any case (a
  Mac runs `READ` as /usr/bin/read); so does a ksh script with a `<<#` heredoc, a script or a
  program run by a path that is not plain text (`bash "$t"`) or from a folder the command writes
  into but for a file it wrote there, and one run by its path where the command unpacks, patches or
  copies a folder. Quoted text with a substitution's start in it counts as in a word. Where it
  cannot tell, every such space shows. The same goes for a Monitor's command and, in the trust
  sheet, for a hook, a helper, a skill's command and a git filter; between the arguments of an MCP
  server, or of a hook run without a shell, every such space shows. A script another program writes
  by itself, as `sed`'s `w`, `sort -o`, `split`, perl, python or awk can, is not followed, nor a
  string another program runs in a shell of its own, such as python's `os.system` or a Makefile's
  recipe. A long command shows at once, read once, and reading one takes at most a fixed time and
  memory: a command longer than 64 KB, or that would take more to read than a fixed budget, has
  every such space show, as a tool's input with many commands and a trust sheet's items share one
  such budget (`x=…; bash -c "$x $x …"` of 24 KB took gigabytes, and crashed the page with the
  approval on it again after each reload).
- In a PowerShell command such a space shows as it is, as PowerShell takes it for a space, unless
  the command hands a script to bash, sh, wsl or ssh, which read it otherwise: then every one shows,
  with the warning; in the trust sheet too, for a hook PowerShell runs.
- Ordinary text on an approval shows as it is, with no warning, as in Claude Code and Claude
  Desktop: an emoji whole, in a command too, with its style, keycap, skin tone, flag and the joiners
  between its pictures (a joined emoji such as a technologist warned in 0.4.0); a space other than a
  plain one in a path, in words or in a command's quotes, such as the narrow one macOS puts in a
  screenshot's name or a full-width one between Chinese words in a commit message; Apple's logo.
  Words keep the joiners Persian and the Indic scripts are written with: what Claude says a command
  does, a web search, what an agent is to do, a task, a tool's message and the caption of a file it
  asks to send (a web search in Sinhala or Persian warned).
- The trust sheet lists a hook's arguments: a hook run without a shell (with `args`) showed only its
  program.
- The trust sheet reads a folder's files as Claude Code reads them. A `.mcp.json` in a folder that
  holds the repository was not read, though Claude Code reads one from every folder up to the file
  system's top and starts its servers with the session: with `outer/.mcp.json` above the repository
  `outer/repo`, a session there started with nothing asked, and the server ran. The folders above
  the repository's top are now read for their `.mcp.json`, short of your home folder, whose files
  are your own. A skill saved as `SKILL.MD`, which Claude Code opens on a Mac as `SKILL.md`, listed
  nothing, nor did a command or an agent more than ten folders down, which Claude Code finds at any
  depth: such a folder is now named above the list. A `.claude/settings.json` or `.mcp.json` saved
  with a byte-order mark, as Windows' Notepad saves it, or as UTF-16, listed nothing, so the folder
  was not asked about and Claude Code started with its hooks and servers; one Pelican cannot read as
  JSON is listed by its name. A skill's, command's or agent's frontmatter whose lines end with a
  carriage return alone, which Claude Code's YAML breaks at, hid its allowed-tools and hooks, and a
  line separator (U+2028) on a key's line, which it reads as text, the key. A hook's or a server's
  YAML shows with its lines as written, so a second line that runs curl no longer reads as part of a
  `#` comment on the first, and the sheet says where an escape such as `\n` reads otherwise than it
  is written. A folder's files are read in time that grows with their size, not with its square: in
  0.4.0, a skill whose frontmatter was 480 KB of list items naming a power held the server for half
  a minute, a command of a megabyte whose ```! block of blank lines never ends for four minutes, and
  a skill of 1.1 MB with a line separator after a line of keys for a minute, after which the folder
  counted as bringing nothing. The sheet lists from a file up to 200 items and 256 KB of them as it
  shows them, and from a folder up to 1,000 and 1 MB, reading up to 32 MB of its files, more than
  any project brings. An item it warns of, and Pelican's own word on what it could not read, are
  always kept, so no number of harmless items leaves one out, and what the repository's git config
  runs is read and listed whatever the folder's other files bring. Past that the sheet names, above
  the list and in red, the first three files it shows part of and how many more, and the folder is
  asked about as before, also where it lists nothing. A hook whose type or arguments are nested too
  deep to read shows as one Pelican cannot read, where the request failed and nothing started.
- A notification keeps a flag made of tags only for England, Scotland and Wales, the three Unicode
  recommends; other tags after a black flag, which can spell anything unseen, are left out. The
  repository's check for hidden characters holds the docs to the same three.

### Site, docs and project

- The demo, and the live demo on the website, have a pinned session and a file Claude sent: in "Try
  the dark theme on my phone", a screenshot of the settings page in dark. Export as Markdown
  downloads the session in the live demo too, where it fetched nothing, its folder named
  `~/code/acme-web` as the demo shows it, not by where the site was built.
- The docs say what the install takes: about 150 MB to download, about 400 MB on disk.
- The tests pass in any order, at any time of day, and hold on a busy computer: each starts from a
  state of its own, a page's tests wait up to 3 seconds for what they look for, and those that
  start a shell or Pelican give it time to start and leave nothing running when they fail. CI checks
  that an install brings one Claude Code, and the smoke test that Export as Markdown downloads.

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

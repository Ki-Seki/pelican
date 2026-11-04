# Changelog

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

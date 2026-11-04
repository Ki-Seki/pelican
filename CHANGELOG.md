# Changelog

## 0.2.0

The first public release.

- Runs on its own: `npm install -g pelican-cc`, then `pelican`. Listens on `127.0.0.1`; an optional
  password (`pelican password`) protects it beyond this computer, with host and origin checks
  against DNS rebinding and cross-site requests.
- `pelican --demo` shows made-up sessions, with nothing of yours involved.
- Every session's whole history, back past each compaction, with a divider where the context was
  compacted; older pages load as you scroll up.
- Three ways to read a session (Summary, Normal, Verbose), and a settings page: theme, the default
  view, what Enter does, how the session list is grouped and how dense it is, notifications.
- A menu for each session: rename, branch, export as Markdown, delete, copy the command that
  continues it in a terminal. Edit an earlier prompt and send it again on a branch.
- `/` commands and `@` files in the composer, ultracode next to effort and fast mode, the task list
  pinned above the composer, how full the context is, and each turn's time, tokens and cost.
- Images open full screen. A failed send gives the text back to edit.

## 0.1.0

A phone-first web app for Claude Code sessions: the session list, live chat with approvals,
images and files, notifications, and sessions other apps are working on.

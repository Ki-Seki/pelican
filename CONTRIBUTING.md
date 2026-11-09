# Contributing

Thanks for helping. Bug reports with the steps to reproduce them, and pull requests that keep the
app small and quiet, are both welcome.

## Set up

You need Node 22.12 or newer and Claude Code installed and signed in on your computer: Pelican
runs it. `npm ci` installs the Agent SDK beside the code, a devDependency, which Pelican loads
there rather than fetching its own copy.

```bash
npm ci
npm run dev
```

`npm run dev` starts the server on port 7860, restarting it when its code changes, and the web app
on <http://127.0.0.1:5173> with hot reload. In development nobody signs in (it sets
`PELICAN_AUTH=none` and stays on `127.0.0.1`); `PELICAN_AUTH=token npm run dev` tries the sign-in.
To work without touching your own sessions, build once and use the demo:
`npm run build && npm run demo`.

## Before you send a change

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` also writes `THIRD_PARTY_NOTICES`, which npm ships: each package built into the
server (by esbuild's metafile, and those whose code a file of Pelican's adapts, such as xterm's
serializer) and the web app (by the modules Vite puts in it), with its version and license in full.
It fails if a package built in is not in it, or comes with no license it can name;
`scripts/notices.mjs` says how each is read. The terminal's PTY, `@lydell/node-pty`, is not built
in: `node scripts/pty-binaries.mjs`, which CI runs, checks it, as `package-lock.json` pins it, against
Microsoft's node-pty, and a new version needs its own few files read and pinned there first.

The tests never see your own Claude Code sessions or Pelican sign-in: `test/setup.ts` points them
at temporary folders before anything reads the environment, and keeps your git settings out of the
repositories they make. Nor do they run your Claude Code: they run the one the Agent SDK's package
for your platform brings, which `npm ci` installed beside it, the version Pelican is tested with.

Check what you changed in a browser, at phone size too. `node scripts/smoke.mjs` opens the built
app with made-up sessions in headless Chrome, every session and sheet, on a phone and wide, light
and dark, and fails on any page error, console error or failed request; CI runs it, and runs it on
the site too (`node scripts/site.mjs _site && node scripts/smoke.mjs _site`).
`node scripts/shot.mjs <url> <out.png>` takes a screenshot, and
`node scripts/e2e-live.mjs <link> <folder> <out>` drives one real turn through the app against a
running Pelican (the link it printed, with the token). Set `CHROME` if Chrome is not in the usual
place, and `PELICAN_DEMO_PORT` if the port a script starts its demo on is taken.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/server/cli.ts` | The `pelican` command: options, `pelican token`, `pelican password`, start-up checks |
| `src/server/auth.ts` | The access token, the password, the sign-in cookie and the sign-ins signed out |
| `src/server/app.ts` | The HTTP API, and the host, origin, request and sign-in checks in front of it |
| `src/server/runner.ts` | Runs Claude Code through the Agent SDK, one process per active session |
| `src/server/claude-code.ts` | Which Claude Code runs (the user's own), its version, whether it is older than the one Pelican was tested with, and whether it is signed in |
| `src/server/agent-sdk.ts` | Anthropic's Agent SDK, loaded only here: where npm installed it, else Pelican's own copy, fetched from npm once for each version |
| `src/server/history.ts` | Reads a transcript, across compactions, incrementally |
| `src/server/feed.ts` | Delivers a session's new messages to the pages watching it |
| `src/server/kept.ts`, `archive.ts`, `pinned.ts` | Archived and pinned sessions, never both: Pelican's own, in its state folder, apart from Claude Desktop's |
| `src/server/live.ts`, `waiting.ts` | Sessions other apps are running, from Claude Code's own registry, and when one waits for you |
| `src/server/trust.ts` | Folder trust: what a folder would run, and whether it is trusted |
| `src/server/phone.ts` | `pelican phone`: the phone's address and its one-time QR code |
| `src/server/service.ts` | `pelican service`: the launchd agent or systemd unit |
| `src/server/awake.ts` | Keeping the computer awake while Claude works |
| `src/server/running.ts` | The note a running Pelican leaves, so `pelican token` and `pelican phone` find it |
| `src/server/local.ts` | Where the command line reaches the running Pelican, and whether it is the one this account started |
| `src/server/workspace.ts`, `changes.ts`, `search.ts` | Changes and files: git status and diffs, what each turn changed from the transcript, file search |
| `src/server/shell.ts`, `shell-runs.ts` | `!` commands: running one, its live output and Stop, and writing it as Claude Code does |
| `src/server/side-chat.ts` | Side chats: the read-only copy of a session, and telling one apart |
| `src/server/actions.ts`, `markdown.ts` | Fork, delete and Export as Markdown: prompts written as text, and a reply read as Markdown readers read it, kept to itself in any of them |
| `src/server/rewind.ts`, `rewound.ts` | Rewind to here and Undo rewind: the code from Claude Code's own copies, the conversation from just before the message, and the cut Pelican keeps until the next message |
| `src/server/defaults.ts` | What new sessions start with, read from Claude Code's settings as Claude Code reads them, and written back as `/model` and `/config` write them |
| `src/server/pull-requests.ts` | A pull request's card: what `gh` says of it, where it is installed and signed in |
| `src/server/update.ts` | Updating from Settings: asking npm's registry, installing where npm installed Pelican, and starting again |
| `src/server/terminals.ts`, `pty.ts` | Terminals: the shell in a PTY, the server's copy of its screen, its socket and flow control, and the optional PTY package |
| `src/server/terminal-snapshot.ts` | The screen a page that comes back gets: xterm's serializer, fixed where it drew otherwise, and what it leaves out |
| `src/shared/terminal-widths.ts`, `terminal-guards.ts` | What every terminal's xterm draws with, on the server and on a page: Unicode 11's widths with at most 11 marks on a character, guards against output xterm throws on, or does too much with (counts far past the screen, links, titles, a reset after a reset), and output cut into pieces of bounded work, also for sequences that work over the whole screen |
| `src/web/components/WorkspaceTerminal.tsx`, `TerminalScreen.tsx` | The Terminal tab: its terminals, the phone's key row and line field, and the screen (xterm.js, loaded only by the tab) |
| `src/web/lib/terminal-socket.ts`, `terminal-input.ts`, `terminal-cursor.ts`, `terminals.ts` | A page's connection to a terminal, what its keys and pastes send, its cursor, and Open, Run in terminal and Ctrl+` from the rest of the app |
| `src/web/components/RunCommand.tsx`, `src/shared/terminal.ts` | Run in terminal's question, the whole command shown wrapped with its lines numbered and its blanks drawn, and what it runs at all (commandRefusal), the page's reading and the server's |
| `src/server/stats.ts` | Usage and activity, read from every transcript, once and then incrementally |
| `src/server/workflows.ts` | Workflows: a run as Claude Code leaves it in the session's folder (record, journal, agents), and its agents' steps |
| `src/server/demo.ts`, `demo-*.ts`, `src/web/lib/demo.ts` | The made-up sessions of `--demo` and the site's live demo, and what the demo acts out in the page (Allow, a question, Rewind, Fork, Commit changes and Create PR) |
| `src/web/lib/actions.ts`, `components/ActionMenu.tsx` | Each thing's one list of actions (a session, a prompt, a reply, a step, a path, the terminal), and the menu or sheet every way in shows it as |
| `src/web/lib/keyboard.ts`, `components/Shortcuts.tsx` | Claude Desktop's web keys, in one table that the menus and the list of keys (⌘/) are made from |
| `src/web/lib/commands.ts`, `components/CommandMenu.tsx` | The one list of commands behind `/` and ⌘K |
| `src/web/lib/press.ts` | Long presses and left swipes on a phone, and right-clicks |
| `src/web/lib/quote.ts`, `review.ts`, `src/shared/quoted.ts` | Quotes with notes and line comments, written and read back in Claude Desktop's formats |
| `src/shared/requests.ts`, `src/web/lib/requests.ts` | Commit changes and Create PR, in Claude Desktop's own words, and the `<pr-created>` card |
| `public/preview.html` | Where a page or visual Claude made runs, once you tap Run |
| `site/` | The website; `site/docs-src/` holds each page of the docs, which `scripts/site.mjs` wraps (`scripts/docs-pages.mjs`) and builds with the live demo |
| `src/shared/` | Types and logic both sides use |
| `src/web/` | The web app (React, Tailwind) |
| `scripts/` | Build (with the third-party notices), development, the browser smoke test, the site, screenshots, icons, what changed upstream, the registry CI installs the package from, and the check that the terminal's binaries are Microsoft's |

## Keeping up with Claude Code

Pelican pins the Agent SDK exactly, a devDependency: Pelican's package holds none of it, and
fetches Anthropic's own package of that version as it first starts. It runs the user's own Claude
Code, and says when that is older than the one the SDK was made with, which the tests run.
Dependabot proposes each new SDK about a day after it ships, in a pull request of its own that runs
all the checks, and a comment on it says what changed upstream: the Agent SDK's and Claude Code's
changelog entries in between, and the changes to the SDK's types.
`node scripts/upstream-report.mjs <from> <to>` prints that report, and
`node scripts/upstream-report.mjs` what is newer than the pinned version, which the issue "Claude
Code updates to consider" keeps each week, with whether the newest Claude Code, from its own
installer, starts through the pinned SDK as Pelican starts it
(`node scripts/handshake.mjs <folder the SDK is in> <claude>`, which sends nothing to Claude).

## Releasing

1. Bump the version (`npm version <x.y.z> --no-git-tag-version`) and add its section to
   `CHANGELOG.md`; commit and push.
2. Tag that very commit, not whatever is newest by then:
   `git tag v<x.y.z> <commit>` and `git push origin v<x.y.z>`.
3. `gh release create v<x.y.z> --verify-tag --title v<x.y.z> --notes-file <the changelog section>`,
   with `--prerelease` for a release candidate such as `v0.3.0-rc.1`.

Before the bump, take the newest Agent SDK, if all its checks pass with the Claude Code it was made
with.
Then bring the docs' Claude Code coverage table (`site/docs-src/coverage.html`) up to date with what
changed, and the "checked on" dates of the comparison in `README.md`, `site/index.html` and
`site/docs-src/compare.html`.

The release runs the checks again and publishes to npm from GitHub Actions, through npm's trusted
publishing (OIDC, with provenance): no npm token exists anywhere, and only `release.yml` in the
`npm` environment, for a `v*` tag, may publish `pelican-cc`. The package is attached to the
release too. A release candidate goes to npm under the `next` tag, and a fix for an older line
(0.2.4 after 0.3.0) under `latest-0.2`; only the newest version becomes `latest`, what
`npm install -g pelican-cc` installs.

A fix for an older line is made on a branch from that line's last tag
(`git switch -c 0.2.x v0.2.3`). A release runs the workflows of the commit it tags, and the
`release.yml` of 0.2.3 and earlier publishes every version as `latest`, which npm refuses for a
version below it. So copy the current one onto the branch, and commit it, before you tag:
`git checkout main -- .github/workflows/release.yml`. Create its release with `--latest=false`, so
GitHub keeps showing the newest release first.

## Style

- Keep the interface calm: few colors, no decoration that does not carry meaning, plain words and
  little text. Phone first, and good on a computer too.
- Where Claude Code, in the terminal or in Claude Desktop, already has a way of doing something,
  Pelican does it the same way and calls it the same name.
- A setting lives where it takes effect: what belongs to one session in that session, what shapes
  a list next to that list, and only what applies everywhere in Settings. Never the same option in
  two places, and no sheet or menu explains what is plain to see.
- The security model in [SECURITY.md](SECURITY.md) stays as strong, or gets stronger, with every
  change.
- Pelican is built for Claude Code alone: no code written for another tool that runs next to it.
- English in code, interface and docs. Prefer a clear name to a comment, and write a comment for
  why, not what.

The pictures in `docs/` come from `npm run screenshots`, `node scripts/video.mjs` (needs ffmpeg)
and `node scripts/icons.mjs`; redraw them rather than editing the files. The social card,
`docs/shots/og.png`, is kept as uploaded: `npm run screenshots -- --og` draws one. The site and its live demo
build with `node scripts/site.mjs <dir>`.

# Contributing

Thanks for helping. Bug reports with the steps to reproduce them, and pull requests that keep the
app small and quiet, are both welcome.

## Set up

You need Node 22.12 or newer and Claude Code signed in on your computer.

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

The tests never see your own Claude Code sessions or Pelican sign-in: `test/setup.ts` points them
at temporary folders before anything reads the environment, and keeps your git settings out of the
repositories they make.

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
| `src/server/auth.ts` | The access token, the password and the sign-in cookie |
| `src/server/app.ts` | The HTTP API, and the host, origin, request and sign-in checks in front of it |
| `src/server/runner.ts` | Runs Claude Code through the Agent SDK, one process per active session |
| `src/server/claude-code.ts` | Which Claude Code runs, its version, and whether it is signed in |
| `src/server/history.ts` | Reads a transcript, across compactions, incrementally |
| `src/server/feed.ts` | Delivers a session's new messages to the pages watching it |
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
| `src/server/stats.ts` | Usage and activity, read from every transcript, once and then incrementally |
| `src/server/demo.ts` | The made-up sessions of `--demo` |
| `public/preview.html` | Where a page or visual Claude made runs, once you tap Run |
| `site/` | The website and the docs; `scripts/site.mjs` adds the live demo |
| `src/shared/` | Types and logic both sides use |
| `src/web/` | The web app (React, Tailwind) |
| `scripts/` | Build, development, the browser smoke test, the site, screenshots, icons, what changed upstream, and the registry CI installs the package from |

## Keeping up with Claude Code

Pelican pins the Agent SDK exactly, and with it the Claude Code it runs. Dependabot proposes each
new version about a day after it ships, in a pull request of its own that runs all the checks, and
a comment on it says what changed upstream: the Agent SDK's and Claude Code's changelog entries in
between, and the changes to the SDK's types. `node scripts/upstream-report.mjs <from> <to>` prints
that report, and `node scripts/upstream-report.mjs` what is newer than the pinned version, which the
issue "Claude Code updates to consider" keeps each week.

## Releasing

1. Bump the version (`npm version <x.y.z> --no-git-tag-version`) and add its section to
   `CHANGELOG.md`; commit and push.
2. Tag that very commit, not whatever is newest by then:
   `git tag v<x.y.z> <commit>` and `git push origin v<x.y.z>`.
3. `gh release create v<x.y.z> --verify-tag --title v<x.y.z> --notes-file <the changelog section>`,
   with `--prerelease` for a release candidate such as `v0.3.0-rc.1`.

Before the bump, take the newest Agent SDK, and the Claude Code it brings, if all its checks pass.
Then bring the docs' Claude Code coverage table (`site/docs.html#coverage`) up to date with what
changed, and the "checked on" dates of the comparison in `README.md`, `site/index.html` and
`site/docs.html`.

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
and `node scripts/icons.mjs`; redraw them rather than editing the files. The site and its live demo
build with `node scripts/site.mjs <dir>`.

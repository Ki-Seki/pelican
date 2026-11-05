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
| `src/server/history.ts` | Reads a transcript, across compactions, incrementally |
| `src/server/feed.ts` | Delivers a session's new messages to the pages watching it |
| `src/server/demo.ts` | The made-up sessions of `--demo` |
| `src/shared/` | Types and logic both sides use |
| `src/web/` | The web app (React, Tailwind) |
| `scripts/` | Build, development, the browser smoke test, the site, screenshots and icons |

## Releasing

1. Bump the version (`npm version <x.y.z> --no-git-tag-version`) and add its section to
   `CHANGELOG.md`; commit and push.
2. Tag that very commit, not whatever is newest by then:
   `git tag v<x.y.z> <commit>` and `git push origin v<x.y.z>`.
3. `gh release create v<x.y.z> --verify-tag --title v<x.y.z> --notes-file <the changelog section>`,
   with `--prerelease` for a release candidate such as `v0.3.0-rc.1`.

The release runs the checks again and publishes to npm from GitHub Actions, through npm's trusted
publishing (OIDC, with provenance): no npm token exists anywhere, and only `release.yml` in the
`npm` environment, for a `v*` tag, may publish `pelican-cc`. The package is attached to the
release too. A release candidate goes to npm under the `next` tag, and a fix for an older line
(0.2.4 after 0.3.0) under `latest-0.2`; only the newest version becomes `latest`, what
`npm install -g pelican-cc` installs.

## Style

Keep the interface calm: few colors, no decoration that does not carry meaning, and text that says
what happens in plain words. In code, prefer a clear name to a comment, and write a comment for why,
not what. The pictures in `docs/` come from `npm run screenshots`, `node scripts/video.mjs` (needs
ffmpeg) and `node scripts/icons.mjs`; redraw them rather than editing the files. The site and its
live demo build with `node scripts/site.mjs <dir>`.

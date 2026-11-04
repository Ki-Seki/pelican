<p align="center">
  <img src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/logo.svg" width="64" height="64" alt="">
</p>

<h1 align="center">Pelican</h1>

<p align="center">
  <b>Claude Code in your pocket.</b><br>
  A phone-first web app for the Claude Code sessions on your computer: follow them, answer Claude, approve its changes, start new work.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pelican-cc"><img src="https://img.shields.io/npm/v/pelican-cc?color=0e7490" alt="npm"></a>
  <a href="https://www.npmjs.com/package/pelican-cc"><img src="https://img.shields.io/node/v/pelican-cc?color=0e7490" alt="Node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0e7490" alt="MIT license"></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/phone-dark.png">
  <img alt="Pelican on a phone: the session list, a session waiting for approval of an edit, and a session running in Claude Desktop" src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/phone-light.png">
</picture>

## Why Pelican

- **Every session, from every app.** Sessions you started in the terminal, Claude Desktop or your
  editor are there next to Pelican's own, live while they run, with their whole history, back past
  every compaction.
- **Made for a phone.** Big targets, a composer that stays out of the way, approvals that show the
  diff, and a notification when Claude finishes or needs you. Add it to your Home Screen and it
  opens like an app.
- **Claude Code does the work.** Pelican runs Claude Code through the official
  [Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview), so your login, settings,
  `CLAUDE.md`, skills, MCP servers and permission modes all apply.
- **Light on purpose.** One small Node process and no database. Sessions stay in Claude Code's own
  files; Pelican adds only uploads, push keys and an optional password hash.

## Quick start

See it first, with made-up sessions and nothing of yours involved:

```bash
npx pelican-cc --demo
```

Then, on the computer where you use Claude Code (Node 22.12 or newer, and Claude Code signed in
once with `claude`):

```bash
npm install -g pelican-cc
pelican
```

Open <http://localhost:7860>. To use it from your phone, read on.

## Use it from your phone

Pelican listens on `127.0.0.1`, so only your computer can reach it until you choose a way in.
Whoever can use Pelican can run Claude Code as you, so pick one that keeps everyone else out:

- **Tailscale** (or another private network). Set a password, then let Tailscale serve Pelican over
  HTTPS to your own devices:

  ```bash
  pelican password
  tailscale serve --bg 7860
  ```

  Open `https://<computer>.<tailnet>.ts.net` on your phone.
- **An SSH tunnel**, from a laptop or a phone app that forwards ports:
  `ssh -N -L 7860:127.0.0.1:7860 you@computer`, then open <http://localhost:7860>.
- **Your own reverse proxy** with HTTPS. Tell Pelican the public address with
  `PELICAN_ALLOWED_ORIGINS=https://pelican.example.com`, and set a password, or start it with
  `--no-auth` only if the proxy already authenticates. Pelican works under any path prefix.

Pelican refuses to listen on any other address (`--host 0.0.0.0`) without a password, unless you
pass `--no-auth`.
Notifications need HTTPS or `localhost`; on an iPhone, add Pelican to the Home Screen first.

## What you can do

- **Read** a session three ways: Summary shows your prompts and Claude's replies, Normal folds
  long runs of steps, Verbose opens every step. Tool calls show their diffs, command output and
  images, and plans, questions and task lists get their own cards. For a session running in
  Pelican, turns show their time, tokens and cost, and a ring shows how full the context is.
- **Steer** with the model, effort, fast mode and ultracode, and permission modes from asking
  before every edit to bypassing them. Type `/` for commands and `@` for files, attach photos and
  files, queue a message while Claude works, or stop it.
- **Keep track**: search, group by time or by project, compact rows, unread dots, and which
  sessions are working right now, here or in another app.
- **Manage** a session: rename it, branch it, edit an earlier prompt and send it again (on a
  branch, so the original stays), export it as Markdown, delete it, or copy the command that
  continues it in a terminal.

## Configuration

| Option | Environment | Default | |
| --- | --- | --- | --- |
| `-p, --port` | `PELICAN_PORT` | `7860` | Port to listen on |
| `-H, --host` | `PELICAN_HOST` | `127.0.0.1` | Address to listen on; others need a password |
| `--name` | `PELICAN_MACHINE` | host name | Name shown for this computer |
| `--no-auth` | `PELICAN_AUTH=none` | | Never ask for a password, for when a proxy in front authenticates |
| | `PELICAN_ALLOWED_ORIGINS` | | Comma-separated origins allowed to make changes, such as a proxy's public URL |
| | `PELICAN_ALLOWED_HOSTS` | | Host names answered without a password, besides this computer's (`*` for any) |
| | `PELICAN_SESSION_URL` | | Where a tapped notification opens a session (`{id}` is replaced), for a page that embeds Pelican |
| | `PELICAN_IDLE_CLOSE_MS` | 30 min | How long an idle Claude process stays open; the next message resumes the session |
| | `PELICAN_CLAUDE_PATH` | bundled | The Claude Code executable to run |
| | `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its sessions |
| | `PELICAN_CONFIG_DIR` | `~/.config/pelican` | Where the password hash is kept |
| | `PELICAN_STATE_DIR` | `~/.local/state/pelican` | Uploads, push keys and subscriptions |

`pelican password` sets or changes the password, and `pelican password --off` removes it; either
signs every browser out. `pelican --help` lists everything.

## How it works

![Your phone talks to the Pelican server on your computer, which runs Claude Code through the Agent SDK and reads the transcripts in ~/.claude that every Claude Code app writes](https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/how-it-works.svg)

1. The web app talks to the Pelican server over REST and a WebSocket, which carries Claude's reply
   as it is written, permission requests and status changes.
2. To run a turn, the server starts Claude Code with the Agent SDK, resuming the session, and
   passes your approvals back to it. An idle process is closed after a while; the next message
   resumes the session.
3. Everything else comes from Claude Code's own files: the transcripts in `~/.claude/projects`,
   followed while anyone is watching, give every session's history, whichever app wrote it, and
   the process registry in `~/.claude/sessions` tells which sessions another app is working on.

Security is in [SECURITY.md](SECURITY.md).

## Contributing

```bash
npm ci
npm run dev        # the server and the web app, both reloading on change
npm test && npm run typecheck
```

`npm run build` makes `dist/`, `npm run demo` serves the build with made-up sessions, and
`npm run screenshots` redraws the pictures above from the demo. More in
[CONTRIBUTING.md](CONTRIBUTING.md).

Pelican is an independent project, not made by or affiliated with Anthropic.

## License

[MIT](LICENSE)

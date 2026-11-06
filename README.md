<p align="center">
  <img src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/logo.svg" width="64" height="64" alt="">
</p>

<h1 align="center">Pelican</h1>

<p align="center">
  <b>Every Claude Code session on your computer, on your phone.</b><br>
  No wrapper, no relay, no account.
</p>

<p align="center">
  <a href="https://ki-seki.github.io/pelican/demo/"><b>Try the live demo</b></a> ·
  <a href="https://ki-seki.github.io/pelican/">Website</a> ·
  <a href="https://ki-seki.github.io/pelican/docs.html">Docs</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pelican-cc"><img src="https://img.shields.io/npm/v/pelican-cc?color=0e7490" alt="npm"></a>
  <a href="https://github.com/Ki-Seki/pelican/actions/workflows/ci.yml"><img src="https://github.com/Ki-Seki/pelican/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0e7490" alt="MIT license"></a>
</p>

<a href="https://ki-seki.github.io/pelican/demo/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/phone-dark.png">
  <img alt="Pelican on a phone: the session list, an edit waiting for approval with its diff, and a chart Claude drew" src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/phone-light.png">
</picture>
</a>

<p align="center"><sub>The live demo is the real app with made-up sessions, in your browser. Nothing to install.</sub></p>

Pelican is one small server next to Claude Code. It reads Claude Code's own transcripts, so the
sessions you started in the terminal, Claude Desktop or your editor are all there, live, with their
whole history. It continues them through the official Agent SDK, so your login, settings,
`CLAUDE.md`, skills and MCP servers apply. Your phone reaches it over Tailscale or an SSH tunnel:
nothing sits in between.

## Install

```sh
npm install -g pelican-cc
pelican
```

On the computer where you use Claude Code, with Node 22.12 or newer and Claude Code signed in, on
macOS or Linux. `pelican` prints the link that signs this browser in. The install is about 150 MB
to download and under 400 MB on disk, most of it the copy of Claude Code that the Agent SDK brings.
The command is also called `pelican-cc`, for computers where Python's Pelican has `pelican`.

## On your phone

```sh
tailscale serve --bg 7860
pelican phone
```

With [Tailscale](https://tailscale.com) on the computer and the phone, `tailscale serve` gives
Pelican a private HTTPS address, and `pelican phone` shows a QR code for it. Scan it with the
phone's camera: Pelican opens there, signed in. `pelican service install` keeps Pelican running.
The docs cover [an SSH tunnel or your own proxy](https://ki-seki.github.io/pelican/docs.html#phone).

## What it does

- **Every session, wherever you started it.** Live while it runs, with its whole history back past
  every compaction. When another app is working on one, or waits for you there, Pelican says which
  app; once it is idle, continue it here.
- **All of Claude Code.** Approvals with the diff, plans and questions, steer or queue while Claude
  works, side chats, `!` commands with their output live, `/` commands and skills, `@` files, every
  model and permission mode, rewind and branch, subagents and background tasks, MCP servers.
- **What Claude makes, in place.** Charts and diagrams Claude draws, pages it writes and files it
  sends you show in the conversation, as in Claude Desktop: pages as still pictures until you tap
  Run, pictures side by side, videos and sounds in a player, a PDF in your browser's viewer,
  anything else to download.
- **Changes and files, as in Claude Desktop.** What each turn changed, what is uncommitted, or
  everything since your branch split, with diffs. Search and read the folder; a path in a reply
  opens the file at its line. Comment on a line or quote it, and Create PR asks Claude.
- **Your usage, from every app.** Tokens, sessions and streaks by project, model and app, with your
  plan's limits, or the cost Claude Code estimates on an API key.
- **Made for a phone, good on a computer.** One hand, dictation, a notification when Claude needs
  you or finishes, and a Home Screen icon. On a wide screen, the list, the conversation and the
  changes sit side by side.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/tour.gif" width="320" alt="A tour of Pelican on a phone: a chart and a page Claude made, rendered in place; an edit waiting for approval with its diff; a session another app is running">
</p>

## Compared with

As each project documents it, checked on 5 November 2026:

| | Your sessions | Between phone and computer | Agents | License |
| --- | --- | --- | --- | --- |
| **Pelican** | All of them, from any app, with their whole history | Nothing: Tailscale, an SSH tunnel or your proxy | Claude Code | MIT |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | Those with Remote Control turned on; Claude plans only | Anthropic's servers, which keep the transcript while connected | Claude Code | Part of Claude Code |
| [Yep Anywhere](https://github.com/kzahel/yepanywhere) | Resumes those from the CLI, VS Code and desktop apps | Nothing, or its end-to-end encrypted relay | Claude Code, Codex | MIT |
| [Happy](https://github.com/slopus/happy), [HAPI](https://github.com/tiann/hapi) | Those started in Happy or HAPI | An end-to-end encrypted relay, or with HAPI your own tunnel | Claude Code, Codex and more | MIT, AGPL-3.0 |
| [CloudCLI](https://github.com/siteboon/claudecodeui) | Every session in `~/.claude` | Nothing on your network, or CloudCLI Cloud | Claude Code, Cursor CLI, Codex | AGPL-3.0 |
| SSH and tmux | The ones running in tmux | Nothing | Any | |

Remote Control can answer a prompt waiting in your terminal; Pelican cannot. More in
[the docs](https://ki-seki.github.io/pelican/docs.html#compare).

## Claude Code coverage

Pelican runs Claude Code itself, so your settings, `CLAUDE.md`, hooks, skills, subagents and MCP
servers work as they do in the terminal, and so does any login: a Claude plan, an API key, Bedrock,
Google Cloud or Microsoft Foundry. What Pelican does not do: Remote Control, cloud sessions, a
worktree for each new session, a terminal of its own, or editing files by hand. [The full table](https://ki-seki.github.io/pelican/docs.html#coverage) goes through Claude
Code's features one by one.

## Security

Whoever can use Pelican can run commands as you, so:

- It listens on `127.0.0.1`, and every browser signs in, also on this computer: with the link it
  prints, a QR code that works once, or a password.
- Requests must come from Pelican's own page, under a host name it knows: no cross-site requests,
  no DNS rebinding, no framing by other sites.
- What Claude writes renders in a sandboxed frame that cannot reach Pelican, as a still picture
  until you tap Run.
- A folder runs nothing of its own, such as hooks or MCP servers, until you trust it.

The whole model is in [SECURITY.md](SECURITY.md).

## Questions

**Does it work with my Claude plan?** Pelican runs Anthropic's own Claude Code, unmodified, on your
computer, signed in the way you signed in to `claude`; it never sees, stores or forwards your
credentials, and it is for your own use. Signed in with a plan, what you send from Pelican is Agent
SDK usage and draws from your plan's limits, as
[Anthropic's help center](https://support.claude.com/en/articles/15036540) says (checked on
5 November 2026); the rules are under
[authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

**Why not Remote Control?** Use it if you are on a Claude plan and want to answer, from your phone,
the prompt waiting in your terminal: Pelican cannot. Pelican shows every session without turning
anything on, keeps nothing on anyone's servers, and works with any login, API keys and cloud
providers included.

**Why not SSH and tmux?** That works. Pelican is for what a terminal on a phone does badly: long
transcripts, diffs, approvals in one tap, notifications, charts and pages, and history across
compactions.

**What if my computer sleeps?** A computer that is asleep runs nothing. While Claude works, Pelican
keeps it from going to sleep on its own; to reach Pelican at any time, keep the computer awake, as
[the docs](https://ki-seki.github.io/pelican/docs.html#running) show.

**Does it cost anything, or phone home?** No. Pelican is free and MIT licensed, with no account and
no telemetry. It talks to your browser and, for notifications, to the browser's push service, with
the content encrypted.

[More questions](https://ki-seki.github.io/pelican/docs.html#faq)

## Contributing

```sh
npm ci
npm run dev
```

`npm run dev` runs the server and the web app, both reloading on change; `npm test` and
`npm run typecheck` check a change. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go
through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Pelican is an independent project, not made by or affiliated with Anthropic.

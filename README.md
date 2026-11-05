<p align="center">
  <img src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/logo.svg" width="64" height="64" alt="">
</p>

<h1 align="center">Pelican</h1>

<p align="center">
  <b>Every Claude Code session on your computer, on your phone.</b><br>
  No wrapper, no relay, no account.
</p>

<p align="center">
  <a href="https://ki-seki.github.io/pelican/demo/"><b>Live demo</b></a> ·
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
  <img alt="Pelican on a phone: the session list, a session waiting for approval of an edit, and a chart Claude drew" src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/phone-light.png">
</picture>
</a>

Pelican is one small server next to Claude Code. It reads Claude Code's own transcripts, so the
sessions you started in the terminal, Claude Desktop or your editor are all there, live, with their
whole history; it continues them through the official Agent SDK, so your login, settings,
`CLAUDE.md`, skills and MCP servers apply.

## Try it

The [live demo](https://ki-seki.github.io/pelican/demo/) is the real app with made-up sessions, in
your browser. Nothing to install.

## Install

On the computer where you use Claude Code, with Node 22.12 or newer and Claude Code signed in:

```sh
npm install -g pelican-cc
pelican
```

`pelican` prints the link that signs this browser in. The install is about 150 MB, most of it the
copy of Claude Code that the Agent SDK brings. The command is also called `pelican-cc`, for
computers where Python's Pelican has `pelican`. Pelican runs on macOS and Linux; the docs cover
[keeping it running, updating and removing it](https://ki-seki.github.io/pelican/docs.html#install).

## On your phone

With [Tailscale](https://tailscale.com) on the computer and the phone:

```sh
tailscale serve --bg 7860
```

Then run `pelican phone` with the address it printed, as in
`pelican phone https://laptop.example.ts.net`, and scan the QR code with your phone: Pelican opens
there, signed in. An SSH tunnel or your own proxy work too, as
[the docs](https://ki-seki.github.io/pelican/docs.html#phone) show, and `pelican service install`
keeps Pelican running.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ki-Seki/pelican/main/docs/shots/tour.gif" width="320" alt="A tour of Pelican on a phone: a chart and a page Claude made, rendered in place; an edit waiting for approval with its diff; a session another app is running">
</p>

## What it does

- **Every session, wherever you started it.** The terminal, Claude Desktop, your editor: every
  session is there, live while it runs, with its whole history back past each compaction. A
  session another app is working on says which app; once it is idle, continue it in Pelican.
- **All of Claude Code.** Approvals with the diff, steer or queue while Claude works, `!` commands,
  changes and files, rewind code, branches, subagents, MCP servers, usage limits, every model and
  mode, `/` commands and `@` files. Charts Claude draws and pages it writes render right in the
  conversation.
- **Made for a phone.** Calm and quick with one hand. A notification when work you sent from
  Pelican finishes or needs you, dictation, and a Home Screen icon that opens it like an app.

## Compared with

As each project documents it, checked on 5 November 2026:

| | Your sessions | Between phone and computer | Agents | License |
| --- | --- | --- | --- | --- |
| **Pelican** | All of them, from any app, with their whole history | Nothing: Tailscale, an SSH tunnel or your proxy | Claude Code | MIT |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | Those with Remote Control turned on; Claude plans only | Anthropic's servers, which keep the transcript while connected | Claude Code | Part of Claude Code |
| [Yep Anywhere](https://github.com/kzahel/yepanywhere) | Resumes those from the CLI, VS Code and desktop apps | Nothing, or its end-to-end encrypted relay | Claude Code, Codex | MIT |
| [Happy](https://github.com/slopus/happy), [HAPI](https://github.com/tiann/hapi) | Those started with `happy` or `hapi` | An end-to-end encrypted relay, or with HAPI your own tunnel | Claude Code, Codex and more | MIT, AGPL-3.0 |
| [CloudCLI](https://github.com/siteboon/claudecodeui) | Every session in `~/.claude` | Nothing on your network, or CloudCLI Cloud | Claude Code, Cursor CLI, Codex | AGPL-3.0 |
| SSH and tmux | The ones running in tmux | Nothing | Any | |

Remote Control can answer a prompt waiting in your terminal; Pelican cannot. More in
[the docs](https://ki-seki.github.io/pelican/docs.html#compare).

## Security

Whoever can use Pelican can run commands as you, so:

- It listens on `127.0.0.1`, and every browser signs in, also on this computer: with the token in
  the link it prints, or with a password.
- Requests must come from Pelican's own page, under a host name it knows: no cross-site requests,
  no DNS rebinding, no framing by other sites.
- What Claude writes renders in a sandboxed frame that cannot reach Pelican, and images in a reply
  load only from Pelican.
- A folder runs nothing of its own until Claude has worked in it, and git runs there without
  hooks, the file-system monitor, external diffs or text converters.

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
keeps it awake; to reach Pelican at any time, keep the computer from sleeping, as
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

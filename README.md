# Pelican

A phone-first web app for your Claude Code sessions. It lists every session on the machine (the ones you started in the terminal, in Claude Desktop, or here), shows them the way Claude Code itself resolves them, and lets you carry on any of them from a browser.

It is the fourth entry of AI Server (`~/repos/ai-server`), one instance per machine, mounted at `/_m/<machine>/pelican/`.

## What it does

- **Sessions**: every session on the machine, newest activity first. Activity is the last real turn, not the file's mtime, which Claude Desktop moves when it appends metadata. Running, waiting and live sessions are pinned on top; search and per-project filters.
- **Chat**: Claude's prose in full; tool calls folded into one line each (file name, command description, `+3 −1` for edits) that open to the diff, command output or subagent result. Task lists, questions and plans render as cards.
- **Running turns**: one long-lived Claude process per session (the Claude Agent SDK, with your user and project settings), so follow-ups start instantly and background work keeps running between turns. Streaming text, Stop, queued messages.
- **Controls**: model, effort and fast mode from your account's live model list; permission mode (ask, accept edits, plan, auto, bypass), changeable mid-session.
- **Approvals**: tool approvals with the diff or command, "always allow" where Claude Code offers it; answers to Claude's questions; plan review (approve with or without accepting edits, or keep planning).
- **Live follow**: a session another client is writing (Desktop, the terminal) updates in place.
- **Attachments**: photos and files from the phone; photos are shrunk before upload, files are saved on the machine for Claude to read.
- **Notifications**: web push when a turn finishes or needs you; tapping one opens the session (inside the AI Server entry page when there).

## Run

```bash
npm install
npm run dev        # API on :7860 (restarts on change) + Vite on :5173
npm run build      # dist/web (the app) and dist/server/index.js
PELICAN_PORT=7860 node dist/server/index.js
```

| Variable | Default | |
|---|---|---|
| `PELICAN_PORT` / `PELICAN_HOST` | `7860` / `127.0.0.1` | Where it listens. It has no login of its own: keep it on localhost behind a proxy that authenticates. |
| `PELICAN_MACHINE` | host name | Name shown in the app. |
| `PELICAN_ALLOWED_ORIGINS` | | Extra origins allowed to send requests, besides the page's own host. |
| `PELICAN_STATE_DIR` | `~/.local/state/pelican` | Uploads, push keys and subscriptions. |
| `PELICAN_CLAUDE_PATH` | the SDK's bundled CLI | A different `claude` binary. |
| `PELICAN_IDLE_CLOSE_MS` | 30 min | An idle Claude process is closed after this; the next message resumes the session. |

## How it fits together

- `src/server`: Hono HTTP API and a WebSocket. Sessions and messages come from the Agent SDK (`listSessions`, `getSessionMessages`), so forks and compactions read as Claude Code reads them. `runner.ts` drives turns; `feed.ts` merges a turn's stream with changes other clients write to the transcript (same message ids, so nothing shows twice).
- `src/web`: React + Tailwind. Every URL is relative to the page, so the app works under any path prefix; routes live in the query string (`?s=<id>`).
- `scripts/shot.mjs`, `scripts/e2e-*.mjs`: screenshots and end-to-end runs against a local server, using the installed Chrome (headless).

## Deploy (AI Server)

`npm run build && npm pack`, put `pelican-<version>.tgz` in `~/repos/ai-server/vendor/` (remove the old one), bump the version for each new package, and deploy AI Server as usual; the bootstrap installs a package whose version differs from the installed one.

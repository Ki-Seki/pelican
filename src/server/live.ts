import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';
import { DEMO_LIVE_SESSION } from './demo.js';

/** A Claude Code process outside this app working on a session right now. */
export type LiveProcess = { app?: string; busy: boolean };

/**
 * Claude Code's own clients, by the entrypoint they record. Any other program
 * that runs Claude Code is just "elsewhere": Pelican assumes nothing about it.
 */
const CLAUDE_CLIENTS: Record<string, string> = {
  'claude-desktop': 'Claude Desktop',
  cli: 'the terminal',
  'claude-vscode': 'VS Code',
};

let cache: { at: number; byId: Map<string, LiveProcess> } | undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Sessions other apps are running, from Claude Code's own registry: every
 * Claude Code process writes `~/.claude/sessions/<pid>.json` with its session
 * id, the app that started it and whether it is busy. This sees a turn that
 * is several minutes into a long command, which writes nothing to the
 * transcript meanwhile. Entries of exited processes are ignored.
 */
export async function liveProcesses(): Promise<Map<string, LiveProcess>> {
  if (config.demo) return new Map([[DEMO_LIVE_SESSION, { app: 'Claude Desktop', busy: true }]]);
  if (cache && Date.now() - cache.at < 1500) return cache.byId;
  const dir = path.join(config.claudeHome, 'sessions');
  const byId = new Map<string, LiveProcess>();
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    // Older Claude Code, or none running.
  }
  await Promise.all(names.map(async (name) => {
    try {
      const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as {
        pid?: number; sessionId?: string; status?: string; entrypoint?: string;
      };
      if (!entry.sessionId || typeof entry.pid !== 'number' || entry.pid === process.pid || !alive(entry.pid)) return;
      const busy = entry.status !== undefined && entry.status !== 'idle';
      const app = CLAUDE_CLIENTS[entry.entrypoint ?? ''];
      const known = byId.get(entry.sessionId);
      // A session open in two places: the busy one is what matters.
      if (!known || (busy && !known.busy)) byId.set(entry.sessionId, { ...(app ? { app } : {}), busy });
    } catch {
      // Being rewritten; the next read gets it.
    }
  }));
  cache = { at: Date.now(), byId };
  return byId;
}

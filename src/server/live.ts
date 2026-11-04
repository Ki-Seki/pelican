import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/** A Claude Code process of another app working on a session right now. */
export type LiveProcess = { app: string; busy: boolean };

const APP_NAMES: Record<string, string> = {
  'claude-desktop': 'Desktop',
  claudecodeui: 'CloudCLI',
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
      const app = APP_NAMES[entry.entrypoint ?? ''] ?? 'another app';
      const known = byId.get(entry.sessionId);
      // A session open in two apps: the busy one is what matters.
      if (!known || (busy && !known.busy)) byId.set(entry.sessionId, { app, busy });
    } catch {
      // Being rewritten; the next read gets it.
    }
  }));
  cache = { at: Date.now(), byId };
  return byId;
}

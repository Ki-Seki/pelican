import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.js';
import { DEMO_LIVE_SESSION } from './demo.js';

/**
 * A Claude Code process outside this app with a session open: busy, or idle and holding the
 * conversation as it last saw it. `updatedAt` is when it last worked on it.
 */
export type LiveProcess = { app?: string; busy: boolean; updatedAt?: number };

const run = promisify(execFile);

/** Parent of each process, to tell this app's own Claude processes from other apps'. */
async function parents(pids: number[]): Promise<Map<number, number> | undefined> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await run('ps', ['-o', 'pid=,ppid=', '-p', pids.join(',')], { timeout: 3000 });
    const map = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid) map.set(pid, ppid);
    }
    return map;
  } catch {
    return undefined;
  }
}

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
  type Entry = { pid?: number; sessionId?: string; status?: string; entrypoint?: string; updatedAt?: number };
  const entries = (await Promise.all(names.map(async (name) => {
    try {
      const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as Entry;
      return entry.sessionId && typeof entry.pid === 'number' && entry.pid !== process.pid && alive(entry.pid) ? entry : undefined;
    } catch {
      return undefined; // Being rewritten; the next read gets it.
    }
  }))).filter((e): e is Entry & { pid: number; sessionId: string } => Boolean(e));
  // This app's own Claude processes are its children; when that cannot be told, those of the SDK.
  const parent = await parents(entries.map((e) => e.pid));
  for (const entry of entries) {
    const ours = parent ? parent.get(entry.pid) === process.pid : entry.entrypoint === 'sdk-ts';
    if (ours) continue;
    const busy = entry.status !== undefined && entry.status !== 'idle';
    const app = CLAUDE_CLIENTS[entry.entrypoint ?? ''];
    const known = byId.get(entry.sessionId);
    const updatedAt = Math.max(known?.updatedAt ?? 0, typeof entry.updatedAt === 'number' ? entry.updatedAt : 0) || undefined;
    // A session open in two places: the busy one is what matters.
    const pick = !known || (busy && !known.busy) ? { ...(app ? { app } : {}), busy } : known;
    byId.set(entry.sessionId, { ...pick, ...(updatedAt ? { updatedAt } : {}) });
  }
  cache = { at: Date.now(), byId };
  return byId;
}

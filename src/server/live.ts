import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.js';
import { demoLiveProcesses } from './demo.js';

/**
 * A Claude Code process outside this app with a session open: busy, or idle and holding the
 * conversation as it last saw it. `updatedAt` is when it last worked on it.
 */
export type LiveProcess = {
  app?: string;
  /** Working on the session, or waiting there for an answer. */
  busy: boolean;
  /** What it waits for, in Claude Code's words ("permission prompt", "input needed"), when it waits. */
  waiting?: string;
  /** When it began waiting, ms since epoch. */
  waitingSince?: number;
  updatedAt?: number;
};

const run = promisify(execFile);

type Proc = { ppid: number; comm: string };

/** Every process's parent and name, in one `ps` (none when ps is not there). */
async function processes(): Promise<Map<number, Proc> | undefined> {
  try {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    const map = new Map<number, Proc>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) map.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3]!.trim() });
    }
    return map;
  } catch {
    return undefined;
  }
}

/** Started by this app, directly or through a wrapper. */
function descends(pid: number, procs: Map<number, Proc>): boolean {
  for (let p = procs.get(pid)?.ppid, hops = 0; p && hops < 8; p = procs.get(p)?.ppid, hops += 1) {
    if (p === process.pid) return true;
  }
  return false;
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

type Entry = {
  pid: number; sessionId: string; status?: string; waitingFor?: unknown; entrypoint?: string; updatedAt?: number; statusUpdatedAt?: number;
};

/** The registry's entries of processes that are still running, as written (this app's own included). */
export async function registry(): Promise<Entry[]> {
  const dir = path.join(config.claudeHome, 'sessions');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    // Older Claude Code, or none running.
  }
  return (await Promise.all(names.map(async (name) => {
    try {
      const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as Partial<Entry>;
      return entry.sessionId && typeof entry.pid === 'number' && entry.pid !== process.pid && alive(entry.pid) ? entry as Entry : undefined;
    } catch {
      return undefined; // Being rewritten; the next read gets it.
    }
  }))).filter((e): e is Entry => Boolean(e));
}

/**
 * Sessions other apps are running, from Claude Code's own registry: every
 * Claude Code process writes `~/.claude/sessions/<pid>.json` with its session
 * id, the app that started it and whether it is busy, or waiting for an
 * answer (a permission prompt, a question). This sees a turn that is several
 * minutes into a long command, which writes nothing to the transcript
 * meanwhile. Entries of exited processes are ignored.
 */
export async function liveProcesses(): Promise<Map<string, LiveProcess>> {
  if (config.demo) return demoLiveProcesses();
  if (cache && Date.now() - cache.at < 1500) return cache.byId;
  const byId = new Map<string, LiveProcess>();
  const entries = await registry();
  // This app's own Claude processes descend from it; when that cannot be told, those of the SDK.
  // A pid now used by something that is not Claude Code is a registry entry left behind.
  const procs = entries.length > 0 ? await processes() : undefined;
  for (const entry of entries) {
    const proc = procs?.get(entry.pid);
    // Node 24 on Linux names its main thread, so ps shows a Claude Code run by Node as MainThread.
    if (procs && (!proc || !/claude|node|bun|disclaimer|MainThread/i.test(proc.comm))) continue;
    const ours = procs ? descends(entry.pid, procs) : entry.entrypoint === 'sdk-ts';
    if (ours) continue;
    const busy = entry.status !== undefined && entry.status !== 'idle';
    const waiting = entry.status === 'waiting' ? (typeof entry.waitingFor === 'string' && entry.waitingFor) || 'input' : undefined;
    const app = CLAUDE_CLIENTS[entry.entrypoint ?? ''];
    const known = byId.get(entry.sessionId);
    // When it last changed between working and idle: other writes to the registry are not work.
    const worked = typeof entry.statusUpdatedAt === 'number' ? entry.statusUpdatedAt : entry.updatedAt;
    const updatedAt = Math.max(known?.updatedAt ?? 0, typeof worked === 'number' ? worked : 0) || undefined;
    // A session open in two places: one waiting for you matters most, then one at work.
    const rank = (p: { busy: boolean; waiting?: string } | undefined) => (p?.waiting ? 2 : p?.busy ? 1 : 0);
    const self = {
      ...(app ? { app } : {}),
      busy,
      ...(waiting ? { waiting, ...(typeof worked === 'number' ? { waitingSince: worked } : {}) } : {}),
    };
    const pick = !known || rank(self) > rank(known) ? self : known;
    byId.set(entry.sessionId, { ...pick, ...(updatedAt ? { updatedAt } : {}) });
  }
  cache = { at: Date.now(), byId };
  return byId;
}

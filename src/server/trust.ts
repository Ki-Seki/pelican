import { realpath } from 'node:fs/promises';
import os from 'node:os';

import { listSessions } from '@anthropic-ai/claude-agent-sdk';

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether Claude Code has run in this very folder, so what the folder brings (its project
 * settings, hooks and MCP servers, its git config with filters and hooks) is something the user
 * already let run. A folder Pelican is only shown (a fresh clone, a download, an address another
 * site opened) runs nothing of its own: probes get the user's settings only, and git does not run.
 *
 * Claude Code files sessions by the folder's path with punctuation turned into dashes, so `a.b`
 * and `a-b` share a list: a session counts only if it ran in this exact folder.
 */
export async function claudeRanIn(folder: string): Promise<boolean> {
  const dir = await realpath(folder).catch(() => folder);
  if (dir === os.homedir()) return true;
  const cached = cache.get(dir);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value = false;
  const sessions = await listSessions({ dir, limit: 50, includeWorktrees: false }).catch(() => []);
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (session.cwd === dir || (await realpath(session.cwd).catch(() => '')) === dir) {
      value = true;
      break;
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(dir, { at: Date.now(), value });
  return value;
}

/** For a session Pelican just started: its folder counts at once, without waiting for the cache. */
export function noteClaudeRanIn(folder: string): void {
  void realpath(folder).then((dir) => cache.set(dir, { at: Date.now(), value: true }), () => undefined);
}

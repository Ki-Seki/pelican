import { realpath } from 'node:fs/promises';
import os from 'node:os';

import { listSessions } from '@anthropic-ai/claude-agent-sdk';

import { lastTurnTime, transcriptPath } from './transcripts.js';

/** A yes holds for a while; a no is asked again soon (the folder's first session may be starting). */
const YES_MS = 30_000;
const NO_MS = 3_000;
const cache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether Claude Code has run in this very folder, so what the folder brings (its project
 * settings, hooks and MCP servers, its git config with filters and hooks) is something the user
 * already let run. A folder Pelican is only shown (a fresh clone, a download, an address another
 * site opened) runs nothing of its own: probes get the user's settings only, and git does not run.
 *
 * Claude Code files sessions by the folder's path with punctuation turned into dashes, so `a.b`
 * and `a-b` share a list, and the list may fill in a session's folder from that shared name. A
 * session counts only by the folder its own transcript records, and only if it is this one.
 */
export async function claudeRanIn(folder: string): Promise<boolean> {
  const dir = await realpath(folder).catch(() => folder);
  if (dir === os.homedir()) return true;
  const cached = cache.get(dir);
  if (cached && Date.now() - cached.at < (cached.value ? YES_MS : NO_MS)) return cached.value;
  let value = false;
  const sessions = await listSessions({ dir, limit: 50, includeWorktrees: false }).catch(() => []);
  for (const session of sessions) {
    const file = await transcriptPath(session.sessionId);
    const recorded = file ? (await lastTurnTime(file))?.lastTurn?.cwd : undefined;
    if (!recorded) continue;
    if (recorded === dir || (await realpath(recorded).catch(() => '')) === dir) {
      value = true;
      break;
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(dir, { at: Date.now(), value });
  return value;
}

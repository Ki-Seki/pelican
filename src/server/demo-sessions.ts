import { readFile, stat } from 'node:fs/promises';

import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import { transcriptPath } from './transcripts.js';

type Row = { type?: unknown; customTitle?: unknown; cwd?: unknown; gitBranch?: unknown; timestamp?: unknown; isMeta?: unknown; message?: { content?: unknown } };

/** What a prompt says: its text, or the text of its first block; nothing for a tool's result. */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find((block): block is { type: 'text'; text: string } => (block as { type?: unknown })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string');
  return first?.text;
}

/**
 * A session of the demo's, as the Agent SDK's getSessionInfo reads it. The demo loads no SDK: it
 * reads the transcripts it wrote itself, which name each session and hold its folder, branch and
 * first prompt plainly (test/demo-parity.test.ts checks that the two read every one alike).
 */
export async function demoSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  const file = await transcriptPath(sessionId);
  if (!file) return undefined;
  const [text, found] = await Promise.all([readFile(file, 'utf8'), stat(file)]).catch(() => [undefined, undefined] as const);
  if (text === undefined || !found) return undefined;
  let customTitle: string | undefined;
  let firstPrompt: string | undefined;
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  for (const line of text.split('\n')) {
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') customTitle = row.customTitle;
    if (typeof row.gitBranch === 'string' && row.gitBranch) gitBranch = row.gitBranch;
    if (cwd === undefined && typeof row.cwd === 'string' && row.cwd) cwd = row.cwd;
    if (createdAt === undefined && typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp))) createdAt = Date.parse(row.timestamp);
    if (firstPrompt === undefined && row.type === 'user' && row.isMeta !== true) firstPrompt = promptText(row.message?.content);
  }
  const summary = customTitle ?? firstPrompt;
  if (!summary) return undefined;
  return {
    sessionId,
    summary,
    lastModified: Math.round(found.mtimeMs),
    fileSize: found.size,
    ...(customTitle ? { customTitle } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

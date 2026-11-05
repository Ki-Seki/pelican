import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { sentFiles } from '../src/server/sessions';

let root: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
const id = randomUUID();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pelican-sent-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  const cwd = path.join(root, 'work');
  const dir = path.join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const at = Date.now();
  // Each row points at the one before it, as Claude Code writes them.
  let parent: string | null = null;
  const row = (type: 'user' | 'assistant', content: unknown[], i: number) => {
    const uuid = randomUUID();
    const line = JSON.stringify({ type, uuid, parentUuid: parent, sessionId: id, cwd, timestamp: new Date(at + i * 1000).toISOString(), message: { role: type, content } });
    parent = uuid;
    return line;
  };
  const send = (callId: string, file: string) => ({ type: 'tool_use', id: callId, name: 'SendUserFile', input: { files: [file] } });
  await writeFile(path.join(dir, `${id}.jsonl`), [
    row('user', [{ type: 'text', text: 'hi' }], 0),
    row('assistant', [send('ran', '/tmp/report.html'), send('failed', '/etc/hosts'), send('unanswered', '/Users/ada/.ssh/id_ed25519')], 1),
    row('user', [{ type: 'tool_result', tool_use_id: 'ran', content: 'Sent.' }, { type: 'tool_result', tool_use_id: 'failed', content: 'No such tool', is_error: true }], 2),
  ].join('\n') + '\n');
});
afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

describe('files Claude sent', () => {
  it('count only from calls that ran: not one that failed, nor one only written', async () => {
    expect([...(await sentFiles(id))]).toEqual(['/tmp/report.html']);
  });
});

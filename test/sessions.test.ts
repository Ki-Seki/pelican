import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/server/config';
import { listSummaries, sessionInfo } from '../src/server/sessions';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const sdk = await original<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...sdk, listSessions: vi.fn(sdk.listSessions), getSessionInfo: vi.fn(sdk.getSessionInfo) };
});

let dir: string;
let project: string;
const saved = { claudeHome: config.claudeHome, env: process.env.CLAUDE_CONFIG_DIR };
/** Each test's sessions are its own, in a folder of its own: the list remembers sessions by id. */
let round = 0;
const id = (n: number) => `0f0f0f0f-${String(round).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const at = new Date(Date.now() - 3600_000).toISOString();
const rows = (session: string, text: string) => `${[
  { type: 'user', uuid: `${session}-u`, parentUuid: null, sessionId: session, cwd: '/w/app', timestamp: at, message: { role: 'user', content: text } },
  { type: 'assistant', uuid: `${session}-a`, parentUuid: `${session}-u`, sessionId: session, cwd: '/w/app', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${text}` }] } },
].map((row) => JSON.stringify(row)).join('\n')}\n`;

// Three sessions in a project, before each test.
beforeEach(async () => {
  round += 1;
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-sessions-'));
  config.claudeHome = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  project = path.join(dir, 'projects', '-w-app');
  await mkdir(project, { recursive: true });
  for (const n of [1, 2, 3]) await writeFile(path.join(project, `${id(n)}.jsonl`), rows(id(n), `task ${n}`));
  vi.mocked(getSessionInfo).mockClear();
  vi.mocked(listSessions).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(() => {
  config.claudeHome = saved.claudeHome;
  if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.env;
});

const ids = async () => (await listSummaries(() => undefined)).map((s) => s.id).sort();

describe('the session list', () => {
  it('reads every transcript once, then only what changed, and shares one look between requests', async () => {
    const [first, second] = await Promise.all([ids(), ids()]);
    expect(first).toEqual([id(1), id(2), id(3)]);
    expect(second).toEqual(first);
    expect(getSessionInfo).toHaveBeenCalledTimes(3);

    vi.mocked(getSessionInfo).mockClear();
    expect(await ids()).toEqual(first);
    expect(getSessionInfo).not.toHaveBeenCalled();

    // One grows, one is new, one is gone.
    await appendFile(path.join(project, `${id(2)}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: id(2) })}\n`);
    await writeFile(path.join(project, `${id(4)}.jsonl`), rows(id(4), 'task 4'));
    await rm(path.join(project, `${id(3)}.jsonl`));
    const summaries = await listSummaries(() => undefined);
    expect(summaries.map((s) => s.id).sort()).toEqual([id(1), id(2), id(4)]);
    expect(summaries.find((s) => s.id === id(2))?.title).toBe('Renamed');
    expect(summaries.find((s) => s.id === id(4))).toMatchObject({ cwd: '/w/app', preview: 'Done: task 4' });
    expect(vi.mocked(getSessionInfo).mock.calls.map(([session]) => session).sort()).toEqual([id(2), id(4)]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('shows a session that went on in another as that one, as Claude Code’s /resume does', async () => {
    await writeFile(path.join(project, `${id(6)}.jsonl`), rows(id(6), 'task 6'));
    await appendFile(path.join(project, `${id(1)}.jsonl`), `${JSON.stringify({ type: 'continued-in', continuedInSessionId: id(6) })}\n`);
    expect(await ids()).toEqual([id(2), id(3), id(6)]);
  });

  it('counts the background work of a session this app runs, and only of one it runs', async () => {
    const summaries = await listSummaries((session) => (session === id(2) ? 'idle' : undefined), () => 2);
    expect(summaries.find((s) => s.id === id(2))).toMatchObject({ status: 'idle', tasks: 2 });
    expect(summaries.filter((s) => s.tasks !== undefined).map((s) => s.id)).toEqual([id(2)]);
  });

  it('says which sessions are pinned, from Pelican’s own pins: never one archived, nor one Claude Desktop starred', async () => {
    const { setPinned } = await import('../src/server/pinned');
    const { setArchived } = await import('../src/server/archive');
    for (const n of [7, 8, 9]) await writeFile(path.join(project, `${id(n)}.jsonl`), rows(id(n), `task ${n}`));
    // Desktop keeps its own pins, as stars, in its own folder: Pelican does not read them.
    const savedHome = config.home;
    config.home = dir;
    const desktop = path.join(dir, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'account', 'org');
    await mkdir(desktop, { recursive: true });
    await writeFile(path.join(desktop, `local_${id(9)}.json`), JSON.stringify({ sessionId: `local_${id(9)}`, cliSessionId: id(9), isStarred: true }));
    await setPinned(id(7), true);
    // Both, as only a file written by hand says: archived wins.
    await setPinned(id(8), true);
    await setArchived(id(8), true);
    try {
      const summaries = await listSummaries(() => undefined);
      expect(summaries.filter((s) => s.pinned).map((s) => s.id)).toEqual([id(7)]);
      expect(summaries.find((s) => s.id === id(8))).toMatchObject({ archived: true });
      expect(summaries.find((s) => s.id === id(8))?.pinned).toBeUndefined();
      expect(summaries.find((s) => s.id === id(9))?.pinned).toBeUndefined();
    } finally {
      config.home = savedHome;
      await setPinned(id(7), false);
      await setPinned(id(8), false);
      await setArchived(id(8), false);
      for (const n of [7, 8, 9]) await rm(path.join(project, `${id(n)}.jsonl`));
    }
  });

  it('finds a session it has not listed yet without reading them all', async () => {
    expect(await ids()).toEqual([id(1), id(2), id(3)]);
    await writeFile(path.join(project, `${id(5)}.jsonl`), rows(id(5), 'task 5'));
    vi.mocked(listSessions).mockClear();
    expect(await sessionInfo(id(5))).toMatchObject({ sessionId: id(5), cwd: '/w/app' });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

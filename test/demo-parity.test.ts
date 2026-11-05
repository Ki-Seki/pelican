import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { sessionChanges } from '../src/server/changes';
import { config } from '../src/server/config';
import { demoLiveProcesses, demoRunState, demoRunStatus, demoRunTasks, demoTaskOutput, prepareDemo } from '../src/server/demo';
import { readLastTurn } from '../src/server/transcripts';

const DEV = 'c4b7d2e9-8888-4c8d-9e1f-000000000010';
const STOPPED = 'e6f9a3b1-9999-4e9f-a0b2-000000000011';
const WAITING = 'f7a1b4c2-aaaa-4fa1-b2c3-000000000012';
const FIRST = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';

// The demo writes its home under the state folder, a temporary one in tests.
beforeAll(() => prepareDemo());

describe('the demo shows what runs on and what waits', () => {
  it('a command still running after its turn: the session is idle with one task, which printed something', () => {
    expect(demoRunStatus(DEV)).toBe('idle');
    expect(demoRunTasks(DEV)).toBe(1);
    expect(demoRunState(DEV)?.tasks).toEqual([{ id: 'bash_1', description: 'Start the dev server', type: 'local_bash', output: true }]);
    expect(demoTaskOutput(DEV, 'bash_1')?.output).toContain('ready in');
    expect(demoTaskOutput(DEV, 'other')).toBeUndefined();
    // The others as before: one waits for an approval here, the rest are not run here.
    expect(demoRunStatus(FIRST)).toBe('waiting');
    expect(demoRunTasks(FIRST)).toBe(0);
    expect(demoRunStatus(STOPPED)).toBeUndefined();
  });

  it('a turn that stopped on an API error, as Claude Code writes it', async () => {
    const file = path.join(config.claudeHome, 'projects', path.join(config.home, 'code', 'docs-site').replace(/[^a-zA-Z0-9]/g, '-'), `${STOPPED}.jsonl`);
    expect((await readLastTurn(file))?.stopped).toBe('API overloaded');
  });

  it('a session waiting for an answer in the terminal, beside the one at work in Claude Desktop', () => {
    const live = demoLiveProcesses();
    expect(live.get(WAITING)).toMatchObject({ app: 'the terminal', busy: true, waiting: 'permission prompt' });
    expect([...live.values()].some((p) => p.app === 'Claude Desktop' && p.busy && !p.waiting)).toBe(true);
  });
});

const SIDE = 'a3f1c2d4-1111-4a1b-8c3d-0000000000a1';
const transcriptOf = (project: string, id: string) => path.join(config.claudeHome, 'projects', path.join(config.home, 'code', project).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const rowsOf = async (file: string) => (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>);

describe('the demo’s side chat', () => {
  it('copies no checkpoints with its session’s rows, as forkSession copies none, and its Changes show none of their turns', async () => {
    const file = transcriptOf('acme-web', SIDE);
    const rows = await rowsOf(file);
    const copied = new Set(rows.filter((row) => row.forkedFrom).map((row) => row.uuid));
    expect(copied.size).toBeGreaterThan(0);
    const kept = rows.filter((row) => row.type === 'file-history-snapshot').map((row) => row.messageId);
    expect(kept.filter((id) => copied.has(id))).toEqual([]);
    expect((await sessionChanges(file, path.join(config.home, 'code', 'acme-web'), true)).turns).toEqual([]);
  });
});

describe('in the demo’s page', async () => {
  // The page's own address, as in a browser.
  Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
  const { startDemo } = await import('../src/web/lib/demo');
  const { api } = await import('../src/web/lib/api');
  const { getView, setRun } = await import('../src/web/lib/store');

  it('Stop on the command Claude left running ends it, and the session has nothing left at work', async () => {
    startDemo({ machine: 'laptop', home: '/demo', version: '0', auth: false, demo: true });
    setRun(DEV, demoRunState(DEV)!);
    await expect(api.stopTask(DEV, 'bash_1')).resolves.toEqual({ ok: true });
    expect(getView(DEV).run?.tasks).toBeUndefined();
    expect(getView(DEV).run?.busy).toBe(false);
  });
});

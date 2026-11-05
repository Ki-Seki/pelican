import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { demoLiveProcesses, demoRunState, demoRunStatus, demoRunTasks, demoTaskOutput, prepareDemo } from '../src/server/demo';
import { readLastTurn } from '../src/server/transcripts';
import { workflowView } from '../src/server/workflows';

const DEV = 'c4b7d2e9-8888-4c8d-9e1f-000000000010';
const STOPPED = 'e6f9a3b1-9999-4e9f-a0b2-000000000011';
const WAITING = 'f7a1b4c2-aaaa-4fa1-b2c3-000000000012';
const FIRST = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';
const WORKFLOWS = 'b5c8e1f4-cccc-4b5c-8d6e-000000000013';

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

describe('the demo shows workflows', () => {
  it('one that finished, read from its own made-up run folder, and one that still runs, in its run state', async () => {
    const finished = (await workflowView(WORKFLOWS, 'toolu_demo_wf_review'))?.workflow;
    expect(finished).toMatchObject({ source: 'record', status: 'completed', name: 'checkout-review', totalTokens: 412_300, durationMs: 361_250 });
    expect(finished?.agents.map((a) => a.label)).toEqual(['review:server', 'review:client', 'verify:server', 'verify:client']);
    const run = demoRunState(WORKFLOWS);
    expect(run?.workflows?.toolu_demo_wf_fixes).toMatchObject({ status: 'running', name: 'checkout-fixes', taskId: 'w7p3m0rtc' });
    expect(run?.tasks).toEqual([{ id: 'w7p3m0rtc', description: 'checkout-fixes', type: 'local_workflow', summary: '1/2 agents' }]);
    expect(demoRunStatus(WORKFLOWS)).toBe('idle');
    expect(demoRunTasks(WORKFLOWS)).toBe(1);
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

  it('Stop on the workflow stops it as Claude Code would: the agents still at work stop with it', async () => {
    setRun(WORKFLOWS, demoRunState(WORKFLOWS)!);
    await expect(api.stopTask(WORKFLOWS, 'w7p3m0rtc')).resolves.toEqual({ ok: true });
    const stopped = getView(WORKFLOWS).run?.workflows?.toolu_demo_wf_fixes;
    expect(stopped?.status).toBe('killed');
    expect(stopped?.agents.map((a) => [a.state, a.error])).toEqual([['done', undefined], ['error', 'Stopped because the workflow was stopped']]);
    expect(getView(WORKFLOWS).run?.tasks).toBeUndefined();
  });
});

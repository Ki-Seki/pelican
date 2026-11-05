// A workflow's run, read from the files Claude Code leaves in the session's folder: how it ended,
// what its agents were asked, and reading those files while Claude Code writes them, from more
// than one page at once. Everything is made up, in the shapes Claude Code 2.1.318 writes.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Workflow, WorkflowAgentPage } from '../src/shared/protocol';

const opened: string[] = [];
/** A disk a little slow to answer (a big file, a busy laptop): reads come back after a few ms. */
const disk = { slow: false };
vi.mock('../src/server/open', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/open')>();
  return {
    ...real,
    openRegular: async (file: string) => {
      opened.push(file);
      const handle = await real.openRegular(file);
      if (!disk.slow) return handle;
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      return Object.assign(handle, {
        read: async (...args: unknown[]) => {
          const out = await read(...args);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return out;
        },
      });
    },
  };
});
/** Sessions another app (the terminal) has open. */
const elsewhere = new Set<string>();
vi.mock('../src/server/live', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/live')>();
  return { ...real, liveProcesses: async () => new Map([...elsewhere].map((id) => [id, { app: 'the terminal', busy: false }])) };
});

const { app } = await import('../src/server/app');
const { accessToken, loadAuth } = await import('../src/server/auth');
const { config } = await import('../src/server/config');
const { refreshTranscriptIndex } = await import('../src/server/transcripts');
const { agentStatus } = await import('../src/shared/workflows');
const { workflowAgentPage, workflowView } = await import('../src/server/workflows');

const project = () => path.join(config.claudeHome, 'projects', '-work-runs');
let count = 0;
const newSession = () => `bbbbbbbb-0000-4000-8000-${String((count += 1)).padStart(12, '0')}`;
const folder = (id: string) => path.join(project(), id);
const META = "export const meta = {\n  name: 'demo-review',\n  description: 'Review the demo app',\n  phases: [{ title: 'Review' }, { title: 'Verify' }],\n}\n";
type Row = Record<string, unknown>;
const MIN = 60_000;

/** The session's transcript, its rows a second apart from `start`. */
async function transcript(id: string, rows: Row[], start = Date.now() - 40 * MIN): Promise<void> {
  await mkdir(project(), { recursive: true });
  let parent: string | null = null;
  const lines = rows.map((row, i) => {
    const uuid = `${id.slice(-4)}-${i}`;
    const line = JSON.stringify({ parentUuid: parent, isSidechain: false, sessionId: id, cwd: '/work/runs', timestamp: new Date(start + i * 1000).toISOString(), uuid, ...row });
    parent = uuid;
    return line;
  });
  await writeFile(path.join(project(), `${id}.jsonl`), `${lines.join('\n')}\n`);
  await refreshTranscriptIndex();
}

async function put(id: string, file: string, content: string | Buffer): Promise<string> {
  const full = path.join(folder(id), file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

const call = (id: string, input: Row = { script: META }): Row => ({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Workflow', input }] } });
const launched = (id: string, runId: string, taskId: string): Row => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Workflow launched in background. Task ID: ${taskId}\nSummary: Review the demo app\nRun ID: ${runId}` }] },
  toolUseResult: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'demo-review', runId, summary: 'Review the demo app', scriptPath: `/x/workflows/scripts/demo-review-${runId}.js` },
});
const said = (text: string): Row => ({ type: 'user', message: { role: 'user', content: text } });
/** What a Claude Code that resumed the session writes of a run it found without a record of its end. */
const orphan = (callId: string, runId: string, taskId: string) => said(`<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${callId}</tool-use-id>\n<status>stopped</status>\n<summary>Background workflow "demo-review" (run ${runId}) didn't finish before the previous session ended</summary>\n<note>It may have been interrupted.</note>\n</task-notification>`);
const started = (key: string, agentId: string, label: string, phase = 'Review') => JSON.stringify({ type: 'started', key, agentId, label, phase });

// An agent's rows, as Claude Code writes them: parentUuid first.
const agentRow = (agentId: string, uuid: string, parent: string | null, at: number, rest: Row) =>
  JSON.stringify({ parentUuid: parent, isSidechain: true, agentId, uuid, timestamp: new Date(at).toISOString(), ...rest });
const toolStep = (agentId: string, n: number, parent: string, at: number) => [
  agentRow(agentId, `${agentId}-${n}a`, parent, at, { type: 'assistant', message: { id: `m${n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `${agentId}-t${n}`, name: 'Read', input: { file_path: `/work/runs/f${n}.ts` } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  agentRow(agentId, `${agentId}-${n}r`, `${agentId}-${n}a`, at + 1, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${agentId}-t${n}`, content: 'ok' }] } }),
];
const steps = (agentId: string, at: number, n = 1) => `${Array.from({ length: n }, (_, i) => toolStep(agentId, i + 1, i ? `${agentId}-${i}r` : 'u0', at + i * 10)).flat().join('\n')}\n`;

const ask = (url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, ...headers } });

beforeAll(async () => {
  config.auth = 'auto';
  await loadAuth();
});
afterEach(() => {
  opened.length = 0;
  elsewhere.clear();
  disk.slow = false;
});

describe('how a run nothing said the end of stands', () => {
  it('one Claude Code found without its end, when the session was resumed, is stopped, open as that session is', async () => {
    // The Claude Code that ran it exited at -30 min; the terminal resumed the session at -29 min
    // and wrote the orphan's notice ("didn't finish before the previous session ended").
    const id = newSession();
    const runId = 'wf_2222bbbb-222';
    await transcript(id, [said('Review it'), call('toolu_o'), launched('toolu_o', runId, 'w2'), orphan('toolu_o', runId, 'w2')], Date.now() - 29 * MIN - 3000);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 30 * MIN));
    elsewhere.add(id);
    expect((await workflowView(id, 'toolu_o'))!.workflow.status).toBe('stopped');
  });

  it('one whose agents went on after that notice is running: the Claude Code that started it is still at it', async () => {
    // Real: Desktop wrote the orphan's notice while Pelican's Claude Code still ran the run, which
    // reported it completed ten minutes later. Its agents wrote after the notice, quiet for a while now.
    const id = newSession();
    const runId = 'wf_2222cccc-222';
    await transcript(id, [said('Review it'), call('toolu_g'), launched('toolu_g', runId, 'w3'), orphan('toolu_g', runId, 'w3')], Date.now() - 20 * MIN);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 5 * MIN));
    elsewhere.add(id);
    expect((await workflowView(id, 'toolu_g'))!.workflow.status).toBe('running');
  });

  it('one whose agents went on after that notice is stopped once no Claude Code has the session open', async () => {
    // The Claude Code that started it died without a word of its own after the notice was written.
    const id = newSession();
    const runId = 'wf_2222ffff-222';
    await transcript(id, [said('Review it'), call('toolu_d'), launched('toolu_d', runId, 'w6'), orphan('toolu_d', runId, 'w6')], Date.now() - 30 * MIN);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 5 * MIN));
    expect((await workflowView(id, 'toolu_d'))!.workflow.status).toBe('stopped');
    // Even with its agents writing just now.
    await appendFile(path.join(folder(id), `subagents/workflows/${runId}/agent-a1.jsonl`), `${toolStep('a1', 2, 'a1-1r', Date.now() - 1000).join('\n')}\n`);
    const now = (await workflowView(id, 'toolu_d'))!.workflow;
    expect(now.agents[0]!.lastProgressAt).toBeGreaterThan(Date.now() - 60_000);
    expect(now.status).toBe('stopped');
    elsewhere.add(id);
    expect((await workflowView(id, 'toolu_d'))!.workflow.status).toBe('running');
  });

  it('one whose agents went on after that notice and then fell silent for longer than Claude Code lets them is stopped', async () => {
    const id = newSession();
    const runId = 'wf_2222dddd-222';
    await transcript(id, [said('Review it'), call('toolu_s'), launched('toolu_s', runId, 'w4'), orphan('toolu_s', runId, 'w4')], Date.now() - 4 * 60 * MIN);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 2 * 60 * MIN));
    expect((await workflowView(id, 'toolu_s'))!.workflow.status).toBe('stopped');
  });

  it('without such a notice, runs while a Claude Code has the session open', async () => {
    const id = newSession();
    const runId = 'wf_2222eeee-222';
    await transcript(id, [said('Review it'), call('toolu_r'), launched('toolu_r', runId, 'w5')]);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 30 * MIN));
    expect((await workflowView(id, 'toolu_r'))!.workflow.status).toBe('stopped');
    elsewhere.add(id);
    expect((await workflowView(id, 'toolu_r'))!.workflow.status).toBe('running');
  });
});

describe('a run another call resumed, while it runs in another app', () => {
  it('counts only the agents at work since that call: those an earlier attempt left are not running', async () => {
    // Real (a Desktop session on this Mac): a resumed run's journal held 191 keys, 10 of them only
    // ever started in attempts before it; Claude Code's record of the run counts 116 agents, all done.
    const id = newSession();
    const runId = 'wf_8888bbbb-888';
    const scriptPath = `/x/workflows/scripts/demo-review-${runId}.js`;
    const resumeAt = Date.now() - MIN;
    await transcript(id, [
      said('Review it'), call('toolu_first'), launched('toolu_first', runId, 'w8a'),
      { type: 'assistant', message: { id: 'm_stop', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: 'w8a' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: '{"message":"Successfully stopped task: w8a"}' }] } },
      call('toolu_again', { scriptPath, resumeFromRunId: runId }),
      launched('toolu_again', runId, 'w8b'),
    ], resumeAt - 5000);
    // The earlier attempt: a1 started and was cut off, a2 finished. The resumed one: a3 at work now.
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, [
      '{"type":"launched"}',
      started('v2:a', 'a1', 'review:old-prompt'),
      started('v2:b', 'a2', 'review:client'),
      '{"type":"result","key":"v2:b","agentId":"a2","result":"ok"}',
      started('v2:c', 'a3', 'review:server'),
    ].join('\n') + '\n');
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', resumeAt - 2 * 60 * MIN));
    await put(id, `subagents/workflows/${runId}/agent-a2.jsonl`, steps('a2', resumeAt - 2 * 60 * MIN));
    await put(id, `subagents/workflows/${runId}/agent-a3.jsonl`, steps('a3', Date.now() - 2000));
    const view = (await workflowView(id, 'toolu_again'))!.workflow;
    expect(view.status).toBe('running');
    expect(view.agents.map((a) => [a.label, agentStatus(a, view.status)])).toEqual([['review:server', 'running']]);
    // The call before it says how it ended there, and shows none of them.
    expect((await workflowView(id, 'toolu_first'))!.workflow).toMatchObject({ status: 'killed', agents: [] });
  });
});

describe('a workflow agent’s prompt', () => {
  it('is its task, not the user’s request Claude Code relays in a message before it', async () => {
    // Every agent of the owner's recent runs starts this way: the relayed user request, then the computed task.
    const id = newSession();
    await transcript(id, [said('Review it'), call('toolu_p'), launched('toolu_p', 'wf_1111aaaa-111', 'w1')]);
    await put(id, 'subagents/workflows/wf_1111aaaa-111/journal.jsonl', `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    const t = Date.now() - MIN;
    await put(id, 'subagents/workflows/wf_1111aaaa-111/agent-a1.jsonl', `${[
      agentRow('a1', 'u0', null, t, { type: 'user', message: { role: 'user', content: '[Workflow harness — user request] The harness relays, verbatim and indented below, the user request that triggered this workflow run.\n  please review the app' } }),
      agentRow('a1', 'u1', 'u0', t + 1, { type: 'user', message: { role: 'user', content: '[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n  Review the server.\n  Report every finding.' } }),
      ...toolStep('a1', 1, 'u1', t + 2),
    ].join('\n')}\n`);
    const page = await workflowAgentPage(id, 'toolu_p', 'a1', {});
    expect(page?.prompt).toBe('Review the server.\nReport every finding.');
    // The frames are no steps of its.
    expect(page?.messages.map((m) => m.uuid)).toEqual(['u0', 'u1', 'a1-1a', 'a1-1r']);
  });
});

describe('reading a run’s files', () => {
  it('opens only the agent asked for to show its steps, not every agent of the run', async () => {
    const id = newSession();
    const runId = 'wf_3333cccc-333';
    await transcript(id, [said('Review it'), call('toolu_r'), launched('toolu_r', runId, 'w3')]);
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({ type: 'workflow_agent', index: n, label: `review:${n}`, phaseTitle: 'Review', agentId: `a${n}`, state: 'done', tokens: 1000, toolCalls: 1, durationMs: 1000 }));
    await put(id, `workflows/${runId}.json`, JSON.stringify({ runId, taskId: 'w3', status: 'completed', workflowName: 'demo-review', phases: [{ title: 'Review' }], workflowProgress: items }));
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `${items.map((a) => `${started(`v2:${a.agentId}`, a.agentId, a.label)}\n{"type":"result","key":"v2:${a.agentId}","agentId":"${a.agentId}","result":"done"}`).join('\n')}\n`);
    for (const a of items) await put(id, `subagents/workflows/${runId}/agent-${a.agentId}.jsonl`, steps(a.agentId, Date.now() - 10 * MIN));
    opened.length = 0;
    const page = await workflowAgentPage(id, 'toolu_r', 'a1', {});
    expect(page?.messages).toHaveLength(2);
    expect(page?.result).toBe('done');
    expect([...new Set(opened.filter((f) => /agent-a\d+\.jsonl$/.test(f)).map((f) => path.basename(f)))]).toEqual(['agent-a1.jsonl']);
  });

  /** A running run read once, then grown: an agent took 3 more steps, a second agent started. */
  async function grownRun(runId: string, callId: string) {
    const id = newSession();
    await transcript(id, [said('Review it'), call(callId), launched(callId, runId, 'w4')]);
    const journal = await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    const t = Date.now() - 5000;
    const file = await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, `${toolStep('a1', 1, 'u0', t).join('\n')}\n`);
    expect((await workflowView(id, callId))!.workflow.agents[0]!.toolCalls).toBe(1);
    await appendFile(file, `${[...toolStep('a1', 2, 'a1-1r', t + 10), ...toolStep('a1', 3, 'a1-2r', t + 20), ...toolStep('a1', 4, 'a1-3r', t + 30)].join('\n')}\n`);
    await appendFile(journal, `${started('v2:b', 'a2', 'review:client')}\n`);
    return { id, journal };
  }

  it('counts each tool call once when two pages ask at once (a phone and a computer)', async () => {
    const { id } = await grownRun('wf_4444dddd-444', 'toolu_c');
    disk.slow = true;
    const both = await Promise.all([workflowView(id, 'toolu_c'), workflowView(id, 'toolu_c'), workflowAgentPage(id, 'toolu_c', 'a1', {})]);
    disk.slow = false;
    expect(both.slice(0, 2).map((a) => (a as { workflow: Workflow }).workflow.agents.find((x) => x.agentId === 'a1')!.toolCalls)).toEqual([4, 4]);
  });

  it('loses no journal line Claude Code writes after two pages asked at once', async () => {
    const { id, journal } = await grownRun('wf_4444eeee-444', 'toolu_c2');
    disk.slow = true;
    await Promise.all([workflowView(id, 'toolu_c2'), workflowView(id, 'toolu_c2')]);
    disk.slow = false;
    // review:client finishes: its result is the next line of the journal.
    await appendFile(journal, `{"type":"result","key":"v2:b","agentId":"a2","result":${JSON.stringify('x'.repeat(400))}}\n`);
    const after = (await workflowView(id, 'toolu_c2'))!.workflow;
    expect(after.agents.find((x) => x.agentId === 'a2')?.state).toBe('done');
  });

  it('reads a journal line Claude Code was writing whole once the rest of it is there, its characters intact', async () => {
    const id = newSession();
    await transcript(id, [said('Review it'), call('toolu_u'), launched('toolu_u', 'wf_7777aaaa-777', 'w7')]);
    const line = Buffer.from('{"type":"result","key":"v2:a","agentId":"a1","result":"审查完成，没有问题"}\n');
    // Read while the line is half on disk, cut inside a character.
    const cut = line.indexOf(Buffer.from('完')) + 1;
    const journal = await put(id, 'subagents/workflows/wf_7777aaaa-777/journal.jsonl', `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    await appendFile(journal, line.subarray(0, cut));
    await workflowView(id, 'toolu_u');
    await appendFile(journal, line.subarray(cut));
    const done = (await workflowView(id, 'toolu_u'))!.workflow.agents[0]!;
    expect(done).toMatchObject({ state: 'done', resultPreview: '审查完成，没有问题' });
  });

  it('follows an agent Claude Code carried on beside the session’s subagents after an interrupt', async () => {
    // Real: the four agents of an interrupted run went on in <session>/subagents/agent-<id>.jsonl,
    // the first row there the child of the run folder's last.
    const id = newSession();
    const runId = 'wf_5555eeee-555';
    await transcript(id, [said('Review it'), call('toolu_i'), launched('toolu_i', runId, 'w5')]);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'fix:server')}\n`);
    const t = Date.now() - 10 * MIN;
    await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, `${toolStep('a1', 1, 'u0', t).join('\n')}\n`);
    await put(id, 'subagents/agent-a1.jsonl', `${[...toolStep('a1', 2, 'a1-1r', t + 10), ...toolStep('a1', 3, 'a1-2r', t + 20)].join('\n')}\n`);
    const page = await workflowAgentPage(id, 'toolu_i', 'a1', {});
    expect(page?.messages.map((m) => m.uuid)).toEqual(['a1-1a', 'a1-1r', 'a1-2a', 'a1-2r', 'a1-3a', 'a1-3r']);
    expect((await workflowView(id, 'toolu_i'))!.workflow.agents[0]).toMatchObject({ toolCalls: 3, lastProgressAt: t + 21 });
  });

  it('sends a run’s labels and phase titles cut, as its record would, however long the journal has them', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_j'), launched('toolu_j', 'wf_2c2c2c2c-222', 'w2')]);
    const long = 'L'.repeat(300_000);
    await put(id, 'subagents/workflows/wf_2c2c2c2c-222/journal.jsonl', `${JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'a1', label: long, phase: long })}\n`);
    const longer = 'M'.repeat(10_000);
    await put(id, 'subagents/workflows/wf_2c2c2c2c-222/agent-a1.meta.json', JSON.stringify({ agentType: longer, description: longer, workflowPhase: longer, pickedEffortModel: longer }));
    const { workflow } = (await (await ask(`/api/sessions/${id}/workflows/toolu_j`)).json()) as { workflow: Workflow };
    const [agent] = workflow.agents;
    expect([agent!.label.length, agent!.phaseTitle!.length, agent!.agentType!.length, agent!.model!.length]).toEqual([200, 120, 120, 120]);
  });
});

describe('an agent’s steps, asked for while it works', () => {
  async function runningAgent(runId: string, callId: string, n: number) {
    const id = newSession();
    await transcript(id, [said('Review it'), call(callId), launched(callId, runId, 'w6')]);
    await put(id, `subagents/workflows/${runId}/journal.jsonl`, `{"type":"launched"}\n${started('v2:a', 'a1', 'review:server')}\n`);
    const file = await put(id, `subagents/workflows/${runId}/agent-a1.jsonl`, steps('a1', Date.now() - 5000, n));
    return { id, file };
  }

  it('come back short when the page has them already, as the run does', async () => {
    const { id } = await runningAgent('wf_6666ffff-666', 'toolu_e', 1);
    const first = await ask(`/api/sessions/${id}/workflows/toolu_e/agents/a1`);
    expect(first.status).toBe(200);
    const tag = first.headers.get('etag');
    expect(tag).toBeTruthy();
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    expect((await ask(`/api/sessions/${id}/workflows/toolu_e/agents/a1`, { 'if-none-match': tag! })).status).toBe(304);
  });

  it('are only those since the last the page has, asked with after', async () => {
    const { id, file } = await runningAgent('wf_6666aaaa-666', 'toolu_a', 2);
    const json = async (url: string) => (await (await ask(url)).json()) as WorkflowAgentPage;
    expect((await json(`/api/sessions/${id}/workflows/toolu_a/agents/a1`)).total).toBe(4);
    await appendFile(file, `${toolStep('a1', 3, 'a1-2r', Date.now()).join('\n')}\n`);
    // From the last one it has, which it gets again: it may have changed.
    const since = await json(`/api/sessions/${id}/workflows/toolu_a/agents/a1?after=3`);
    expect(since).toMatchObject({ total: 6, offset: 3 });
    expect(since.messages.map((m) => m.uuid)).toEqual(['a1-2r', 'a1-3a', 'a1-3r']);
    for (const bad of ['after=-1', 'after=1.5', 'after=x', 'after=1&before=2']) expect([bad, (await ask(`/api/sessions/${id}/workflows/toolu_a/agents/a1?${bad}`)).status]).toEqual([bad, 404]);
  });

  it('come to a few hundred kilobytes at most, also when one message is large', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_b'), launched('toolu_b', 'wf_6a6a6a6a-666', 'w7')]);
    await put(id, 'subagents/workflows/wf_6a6a6a6a-666/journal.jsonl', `${started('v2:a', 'a1', 'big')}\n`);
    // A schema agent's last call: StructuredOutput with a nested value, which no cut of a call's texts reaches.
    const findings = Array.from({ length: 400 }, (_, i) => ({ title: `finding ${i}`, evidence: 'e'.repeat(10_000) }));
    const rows = [
      { parentUuid: null, isSidechain: true, agentId: 'a1', type: 'user', uuid: 'b0', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Review it.' } },
      { parentUuid: 'b0', isSidechain: true, agentId: 'a1', type: 'assistant', uuid: 'b1', timestamp: new Date().toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: { findings, summary: 's'.repeat(50_000) } }] } },
    ];
    await put(id, 'subagents/workflows/wf_6a6a6a6a-666/agent-a1.jsonl', `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const text = await (await ask(`/api/sessions/${id}/workflows/toolu_b/agents/a1`)).text();
    expect(text.length).toBeLessThan(200_000);
    const page = JSON.parse(text) as WorkflowAgentPage;
    const input = (page.messages[1]!.blocks[0] as { input: Record<string, unknown> }).input;
    // What it held, cut, as text: its start is there to read.
    expect(String(input.findings).startsWith('[{"title":"finding 0"')).toBe(true);
    expect(String(input.summary).length).toBeLessThan(10_000);
  });
});

describe('a session with a Workflow call whose meta no string could hold', () => {
  it('still has its runs and its calls read, that one with nothing to say of its meta', async () => {
    // Claude Code refused it ("syntax error and was not launched"); the call stays in the transcript.
    const id = newSession();
    const bad = "export const meta = {\n  name: 'tidy',\n  description: 'Tidy \\u{-1} up',\n  phases: [{ title: 'Tidy' }],\n}\nreturn 1\n";
    await transcript(id, [
      call('toolu_ok'), launched('toolu_ok', 'wf_1b1b1b1b-111', 'w1'), call('toolu_bad', { script: bad }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'Workflow script has a syntax error and was not launched:\nInvalid Unicode escape sequence' }] } },
    ]);
    const list = await ask(`/api/sessions/${id}/workflows`);
    expect(list.status).toBe(200);
    // Its name, as far as it can be read, as for a call still coming in.
    expect(await list.json()).toEqual({ workflows: [{ toolUseId: 'toolu_ok', runId: 'wf_1b1b1b1b-111', name: 'demo-review' }, { toolUseId: 'toolu_bad', name: 'tidy' }] });
    const view = await ask(`/api/sessions/${id}/workflows/toolu_bad`);
    expect(view.status).toBe(200);
    expect(((await view.json()) as { workflow: Workflow }).workflow).toMatchObject({ status: 'stopped', phases: [], agents: [] });
  });
});

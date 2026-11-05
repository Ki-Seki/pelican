import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Workflow } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { loadMessages } from '../src/server/sessions';
import { refreshTranscriptIndex } from '../src/server/transcripts';
import { workflowAgentPage, workflowCalls, workflowView } from '../src/server/workflows';

// Everything here is made up, in the shape Claude Code 2.1.318 writes: a transcript, and beside it
// the session's own folder with a workflow's record, journal, agents and scripts.

const project = () => path.join(config.claudeHome, 'projects', '-work-shop');
let count = 0;
const newSession = () => `aaaaaaaa-0000-4000-8000-${String((count += 1)).padStart(12, '0')}`;
const folder = (id: string) => path.join(project(), id);

const META = "export const meta = {\n  name: 'demo-review',\n  description: 'Review the demo app, then check each finding',\n  phases: [\n    { title: 'Review', detail: 'one agent per area' },\n    { title: 'Verify' },\n  ],\n}\nreturn await agent('Review it')\n";

type Row = Record<string, unknown>;

async function transcript(id: string, rows: Row[], start = Date.now() - 20 * 60_000): Promise<void> {
  await mkdir(project(), { recursive: true });
  let parent: string | null = null;
  const lines = rows.map((row, i) => {
    const uuid = (row.uuid as string | undefined) ?? `${id.slice(-4)}-${i}`;
    const line = JSON.stringify({ parentUuid: parent, isSidechain: false, sessionId: id, cwd: '/work/shop', timestamp: new Date(start + i * 1000).toISOString(), uuid, ...row });
    parent = uuid;
    return line;
  });
  await writeFile(path.join(project(), `${id}.jsonl`), `${lines.join('\n')}\n`);
  await refreshTranscriptIndex();
}

async function put(id: string, file: string, content: string): Promise<string> {
  const full = path.join(folder(id), file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

const call = (id: string, input: Row): Row => ({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Workflow', input }] } });
const launched = (id: string, runId: string, taskId: string): Row => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Workflow launched in background. Task ID: ${taskId}\nSummary: Review the demo app\nRun ID: ${runId}\n\nYou will be notified when it completes.` }] },
  toolUseResult: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'demo-review', runId, summary: 'Review the demo app, then check each finding', scriptPath: `/elsewhere/workflows/scripts/demo-review-${runId}.js` },
});
const notice = (id: string, taskId: string, status: string, extra = '') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/claude-501/x/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Dynamic workflow "Review the demo app" ${status}</summary>${extra}\n</task-notification>`;
const said = (text: string): Row => ({ type: 'user', message: { role: 'user', content: text } });

/** An agent's own transcript: its framed prompt, then a step and an answer, `ago` ms before now. */
function agentRows(agentId: string, ago: number, steps = 1): string {
  const at = (ms: number) => new Date(Date.now() - ago + ms).toISOString();
  const rows: Row[] = [{ parentUuid: null, isSidechain: true, agentId, type: 'user', uuid: `${agentId}-0`, timestamp: at(0), message: { role: 'user', content: '[Workflow harness — computed task] The computed task text follows:\n  Review the server.' } }];
  for (let i = 1; i <= steps; i += 1) {
    rows.push({ parentUuid: rows.at(-1)!.uuid, isSidechain: true, agentId, type: 'assistant', uuid: `${agentId}-${i}a`, timestamp: at(i * 10), message: { id: `m${i}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: '/work/shop/a.ts' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 * i, output_tokens: 40 } } });
    rows.push({ parentUuid: rows.at(-1)!.uuid, isSidechain: true, agentId, type: 'user', uuid: `${agentId}-${i}r`, timestamp: at(i * 10 + 5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `line ${i}` }] } });
  }
  // A copy of an API request: no part of the conversation, though it holds one.
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${JSON.stringify({ type: 'api-request', agentId, params: { messages: [{ type: 'assistant' }] } })}\n`;
}

const agentMeta = (label: string, phase: string, agentType = 'workflow-subagent') => JSON.stringify({ agentType, isBuiltIn: true, description: label, workflowPhase: phase, spawnDepth: 1, pickedEffortModel: 'claude-opus-5-5' });

const RECORD = (taskId: string) => JSON.stringify({
  runId: 'wf_7c2e4a10-9b3', taskId, status: 'completed', workflowName: 'demo-review', summary: 'Review the demo app, then check each finding',
  startTime: Date.now() - 600_000, durationMs: 361_250, totalTokens: 412_300, totalToolCalls: 87, agentCount: 2, result: [{ verdicts: [] }],
  phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify', detail: 'a skeptic re-checks' }], script: META,
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Review' },
    { type: 'workflow_phase', index: 2, title: 'Verify' },
    { type: 'workflow_phase', index: 3, title: 'Cleanup' },
    { type: 'workflow_agent', index: 1, label: 'review:server', phaseIndex: 1, phaseTitle: 'Review', agentId: 'a1', state: 'done', tokens: 120_800, toolCalls: 31, durationMs: 180_000, resultPreview: '{"findings":[]}', promptPreview: 'Review the server.' },
    { type: 'workflow_agent', index: 2, label: 'verify:server', phaseIndex: 2, phaseTitle: 'Verify', agentId: 'a2', state: 'error', error: 'API Error: 529 Overloaded', tokens: 22_000 },
    { type: 'not_an_item' },
  ],
});

const ask = (url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, ...headers } });

let outside: string;
beforeAll(async () => {
  config.auth = 'auto';
  await loadAuth();
  outside = await mkdtemp(path.join(os.tmpdir(), 'pelican-outside-'));
});
afterAll(async () => {
  await rm(config.claudeHome, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('a workflow’s run, from its folder', () => {
  it('once it ended: Claude Code’s record, with its phases, agents and totals', async () => {
    const id = newSession();
    await transcript(id, [said('Review it'), call('toolu_r1', { script: META }), launched('toolu_r1', 'wf_7c2e4a10-9b3', 'w1'), said(notice('toolu_r1', 'w1', 'completed'))]);
    await put(id, 'workflows/wf_7c2e4a10-9b3.json', RECORD('w1'));
    const answer = await workflowView(id, 'toolu_r1');
    expect(answer?.workflow).toMatchObject({
      runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: 'demo-review', description: 'Review the demo app, then check each finding',
      status: 'completed', durationMs: 361_250, totalTokens: 412_300, totalToolCalls: 87, source: 'record', result: JSON.stringify([{ verdicts: [] }], null, 2),
      phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify', detail: 'a skeptic re-checks' }, { title: 'Cleanup' }],
    });
    expect(answer!.workflow.agents.map((a) => [a.label, a.state, a.tokens])).toEqual([['review:server', 'done', 120_800], ['verify:server', 'error', 22_000]]);
    // The call holds its script: it is not sent again.
    expect(answer!.workflow.script).toBeUndefined();
    expect(await workflowCalls(id)).toEqual([{ toolUseId: 'toolu_r1', runId: 'wf_7c2e4a10-9b3', name: 'demo-review' }]);
  });

  it('while it runs: the journal, past lines cut short or of kinds it does not know, and files not there', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_j1', { script: META }), launched('toolu_j1', 'wf_5d8b1e22-c47', 'w2')]);
    const journal = await put(id, 'subagents/workflows/wf_5d8b1e22-c47/journal.jsonl', [
      '{"type":"launched"}',
      '{"type":"started","key":"v2:a","agentId":"a1","label":"review:server","phase":"Review"}',
      '{"type":"started","key":"v2:b","agentId":"a2","label":"review:client","phase":"Review"}',
      '{"type":"restoring"}',
      'not json at all',
      '{"type":"result","key":"v2:a","agentId":"a1","result":{"findings":[{"title":"Empty password"}]},"toolsUsed":["Read"]}',
      '{"type":"result","key":"v2:b","agentId":"a2","res',
    ].join('\n'));
    await put(id, 'subagents/workflows/wf_5d8b1e22-c47/agent-a1.jsonl', agentRows('a1', 10_000, 3));
    await put(id, 'subagents/workflows/wf_5d8b1e22-c47/agent-a1.meta.json', agentMeta('review:server', 'Review', 'general-purpose'));
    // review:client has neither its transcript nor its meta file yet.
    const view = (await workflowView(id, 'toolu_j1'))!.workflow;
    expect(view).toMatchObject({ status: 'running', source: 'journal', name: 'demo-review', phases: [{ title: 'Review' }, { title: 'Verify' }] });
    expect(view.agents).toEqual([
      expect.objectContaining({ index: 1, label: 'review:server', state: 'done', phaseTitle: 'Review', agentId: 'a1', agentType: 'general-purpose', model: 'claude-opus-5-5', tokens: 3142, toolCalls: 3, lastToolName: 'Read', resultPreview: '{ "findings": [ { "title": "Empty password" } ] }' }),
      { index: 2, label: 'review:client', state: 'progress', phaseTitle: 'Review', agentId: 'a2' },
    ]);
    // Claude Code goes on after a torn line with a line of its own; the torn one is passed over.
    await appendFile(journal, '\n{"type":"resumed"}\n{"type":"failed","key":"v2:b","agentId":"a2"}\n');
    expect((await workflowView(id, 'toolu_j1'))!.workflow.agents.map((a) => a.state)).toEqual(['done', 'error']);
  });

  it('ended with the Claude Code that ran it: no word of its end, no one at work in the session, its agents quiet', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_q1', { script: META }), launched('toolu_q1', 'wf_1a2b3c4d-5e6', 'w3')]);
    await put(id, 'subagents/workflows/wf_1a2b3c4d-5e6/journal.jsonl', '{"type":"launched"}\n{"type":"started","key":"v2:a","agentId":"a1","label":"review:server","phase":"Review"}\n');
    await put(id, 'subagents/workflows/wf_1a2b3c4d-5e6/agent-a1.jsonl', agentRows('a1', 30 * 60_000));
    expect((await workflowView(id, 'toolu_q1'))!.workflow).toMatchObject({ status: 'stopped', agents: [{ state: 'progress' }] });
    // A run whose folder is gone (a copy of the session) is that much, no more.
    const copy = newSession();
    await transcript(copy, [call('toolu_q2', { script: META }), launched('toolu_q2', 'wf_9f9f9f9f-000', 'w4')]);
    expect((await workflowView(copy, 'toolu_q2'))!.workflow).toMatchObject({ status: 'stopped', agents: [], phases: [{ title: 'Review' }, { title: 'Verify' }] });
  });

  it('ends as the conversation says: a notice that came while Claude worked, or Claude stopping it', async () => {
    const id = newSession();
    await transcript(id, [
      call('toolu_n1', { script: META }), launched('toolu_n1', 'wf_2e6f9a01-d58', 'w5'),
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice('toolu_n1', 'w5', 'failed').replace('failed</summary>', 'failed: TypeError: x &lt;y&gt;</summary>') } },
      call('toolu_n2', { script: META }), launched('toolu_n2', 'wf_8a1b3c5d-e7f', 'w6'),
      { type: 'assistant', message: { id: 'm_stop', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: 'w6' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: '{"message":"Successfully stopped task: w6"}' }] } },
    ]);
    expect((await workflowView(id, 'toolu_n1'))!.workflow).toMatchObject({ status: 'failed', error: 'TypeError: x <y>' });
    expect((await workflowView(id, 'toolu_n2'))!.workflow.status).toBe('killed');
    // The notice is part of the conversation, as one between turns is.
    expect((await loadMessages(id)).some((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text.startsWith('<task-notification>')))).toBe(true);
  });

  it('shows a run a later call resumed in that call; the earlier one says how it ended', async () => {
    const id = newSession();
    await transcript(id, [
      call('toolu_a', { script: META }), launched('toolu_a', 'wf_7c2e4a10-9b3', 'w7'),
      call('toolu_b', { scriptPath: '/elsewhere/workflows/scripts/demo-review-wf_7c2e4a10-9b3.js', resumeFromRunId: 'wf_7c2e4a10-9b3' }), launched('toolu_b', 'wf_7c2e4a10-9b3', 'w8'),
    ]);
    await put(id, 'workflows/wf_7c2e4a10-9b3.json', RECORD('w8'));
    await put(id, 'workflows/scripts/demo-review-wf_7c2e4a10-9b3.js', META);
    expect((await workflowView(id, 'toolu_a'))!.workflow).toMatchObject({ status: 'killed', agents: [], source: 'journal' });
    const later = (await workflowView(id, 'toolu_b'))!.workflow;
    expect(later).toMatchObject({ status: 'completed', source: 'record', script: META });
  });

  it('is what this Pelican’s Claude reports, while it runs it', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_l1', { scriptPath: '/x/workflows/scripts/demo-review-wf_7c2e4a10-9b3.js' }), launched('toolu_l1', 'wf_7c2e4a10-9b3', 'w9')]);
    await put(id, 'workflows/scripts/demo-review-wf_7c2e4a10-9b3.js', META);
    const live: Workflow = { taskId: 'w9', status: 'running', phases: [], agents: [{ index: 1, label: 'review:server', state: 'progress', agentId: 'a1' }], source: 'live' };
    expect((await workflowView(id, 'toolu_l1', live))!.workflow).toMatchObject({ status: 'running', source: 'live', name: 'demo-review', phases: [{ title: 'Review' }, { title: 'Verify' }], script: META });
  });
});

describe('a workflow agent’s steps', () => {
  it('come a page at a time, from the newest, with its prompt and its result', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_p1', { script: META }), launched('toolu_p1', 'wf_3f9c1a2b-7d4', 'w10')]);
    await put(id, 'subagents/workflows/wf_3f9c1a2b-7d4/journal.jsonl', '{"type":"started","key":"v2:a","agentId":"a1","label":"review:server"}\n{"type":"result","key":"v2:a","agentId":"a1","result":"All clear."}\n');
    await put(id, 'subagents/workflows/wf_3f9c1a2b-7d4/agent-a1.jsonl', agentRows('a1', 60_000, 75));
    const last = await workflowAgentPage(id, 'toolu_p1', 'a1', { limit: 60 });
    expect(last).toMatchObject({ total: 151, offset: 91, prompt: 'Review the server.', result: 'All clear.' });
    expect(last!.messages).toHaveLength(60);
    const before = await workflowAgentPage(id, 'toolu_p1', 'a1', { before: last!.offset, limit: 60 });
    expect(before).toMatchObject({ total: 151, offset: 31 });
    expect(before!.messages.at(-1)!.uuid).not.toBe(last!.messages[0]!.uuid);
    expect((await workflowAgentPage(id, 'toolu_p1', 'a1', { before: 31, limit: 60 }))!.offset).toBe(0);
  });

  it('never come to more than a phone should load at once', async () => {
    const id = newSession();
    await transcript(id, [call('toolu_p2', { script: META }), launched('toolu_p2', 'wf_4a4a4a4a-111', 'w11')]);
    await put(id, 'subagents/workflows/wf_4a4a4a4a-111/journal.jsonl', '{"type":"started","key":"v2:a","agentId":"a1","label":"big"}\n');
    const rows: Row[] = [];
    for (let i = 0; i < 80; i += 1) {
      rows.push({ parentUuid: i ? `b${i - 1}` : null, isSidechain: true, agentId: 'a1', type: i % 2 ? 'user' : 'assistant', uuid: `b${i}`, timestamp: new Date().toISOString(),
        message: i % 2 ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: 'x'.repeat(200_000) }] } : { id: `m${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: '/work/shop/big.txt', content: 'y'.repeat(100_000) } }] } });
    }
    await put(id, 'subagents/workflows/wf_4a4a4a4a-111/agent-a1.jsonl', `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const page = (await workflowAgentPage(id, 'toolu_p2', 'a1', { limit: 60 }))!;
    expect(page.messages.length).toBeLessThan(60);
    expect(JSON.stringify(page).length).toBeLessThan(900_000);
  });
});

describe('the workflow routes', () => {
  let id: string;
  beforeAll(async () => {
    id = newSession();
    await transcript(id, [call('toolu_w1', { script: META }), launched('toolu_w1', 'wf_6b6b6b6b-222', 'w12')]);
    await put(id, 'subagents/workflows/wf_6b6b6b6b-222/journal.jsonl', '{"type":"started","key":"v2:a","agentId":"a1","label":"review:server"}\n{"type":"started","key":"v2:b","agentId":"a2","label":"linked"}\n');
    // Its agent last wrote well before the minute that counts as at work: the run reads the same
    // from one request to the next (at 60 s, it ended between two of them).
    await put(id, 'subagents/workflows/wf_6b6b6b6b-222/agent-a1.jsonl', agentRows('a1', 10 * 60_000));
    // Another run's agent, in the same session.
    await put(id, 'subagents/workflows/wf_7c7c7c7c-333/agent-a9.jsonl', agentRows('a9', 10 * 60_000));
    // An agent file that is a link out of the session's folder, and a record that is one.
    await writeFile(path.join(outside, 'secret.jsonl'), agentRows('a2', 10 * 60_000).replace('Review the server.', 'SECRET'));
    await writeFile(path.join(outside, 'record.json'), RECORD('w12').replace('demo-review', 'SECRET'));
    await symlink(path.join(outside, 'secret.jsonl'), path.join(folder(id), 'subagents/workflows/wf_6b6b6b6b-222/agent-a2.jsonl'));
    await mkdir(path.join(folder(id), 'workflows'), { recursive: true });
    await symlink(path.join(outside, 'record.json'), path.join(folder(id), 'workflows/wf_6b6b6b6b-222.json'));
  });

  it('are behind the same sign-in and mark as every other route', async () => {
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1`, { authorization: '' })).status).toBe(401);
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1`, { 'x-pelican': '' })).status).toBe(403);
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1/agents/a1`, { authorization: '' })).status).toBe(401);
  });

  it('answer with the run, and briefly when the page has it already', async () => {
    const response = await ask(`/api/sessions/${id}/workflows/toolu_w1`);
    expect(response.status).toBe(200);
    const { workflow } = (await response.json()) as { workflow: Workflow };
    expect(workflow).toMatchObject({ source: 'journal', name: 'demo-review' });
    // The record is a link out of the folder: it is not read.
    expect(JSON.stringify(workflow)).not.toContain('SECRET');
    const tag = response.headers.get('etag')!;
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1`, { 'if-none-match': tag })).status).toBe(304);
    expect(await (await ask(`/api/sessions/${id}/workflows`)).json()).toEqual({ workflows: [{ toolUseId: 'toolu_w1', runId: 'wf_6b6b6b6b-222', name: 'demo-review' }] });
  });

  it('read only this run’s own agents, by their own files, inside the session’s folder', async () => {
    const page = await ask(`/api/sessions/${id}/workflows/toolu_w1/agents/a1`);
    expect(page.status).toBe(200);
    expect(((await page.json()) as { prompt: string }).prompt).toBe('Review the server.');
    // Another run's agent, an agent of none, and a link out of the folder.
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1/agents/a9`)).status).toBe(404);
    expect((await ask(`/api/sessions/${id}/workflows/toolu_w1/agents/a404`)).status).toBe(404);
    const linked = await (await ask(`/api/sessions/${id}/workflows/toolu_w1/agents/a2`)).text();
    expect(linked).not.toContain('SECRET');
    expect(JSON.parse(linked)).toMatchObject({ messages: [], total: 0 });
  });

  it('take no path pieces that are not ids, and no session, call or agent that is not there', async () => {
    for (const url of [
      `/api/sessions/${id}/workflows/..%2F..%2F..%2Fetc%2Fpasswd`,
      `/api/sessions/${id}/workflows/toolu_w1/agents/..%2Fjournal`,
      `/api/sessions/${id}/workflows/toolu_w1/agents/a1%2F..%2F..%2Fx`,
      `/api/sessions/${id}/workflows/toolu_w1/agents/a1?before=-1`,
      `/api/sessions/${id}/workflows/toolu_w1/agents/a1?before=1.5`,
      `/api/sessions/${id}/workflows/toolu_w1/agents/a1?before=x`,
      `/api/sessions/${id}/workflows/toolu_missing`,
      '/api/sessions/not-a-session/workflows/toolu_w1',
      '/api/sessions/..%2F..%2Fetc/workflows/toolu_w1',
      '/api/sessions/bbbbbbbb-0000-4000-8000-000000000000/workflows/toolu_w1',
    ]) {
      expect([url, (await ask(url)).status]).toEqual([url, 404]);
    }
    expect(await (await ask('/api/sessions/not-a-session/workflows')).json()).toEqual({ workflows: [] });
  });

  it('read nothing a run id or a script path in a transcript points elsewhere at', async () => {
    const other = newSession();
    await transcript(other, [
      call('toolu_x1', { scriptPath: '../../../../etc/passwd.js' }),
      { ...launched('toolu_x1', 'wf_x', 'w13'), toolUseResult: { status: 'async_launched', taskId: 'w13', taskType: 'local_workflow', runId: 'wf_../../../etc', scriptPath: '/etc/passwd.js' } },
    ]);
    const view = (await workflowView(other, 'toolu_x1'))!.workflow;
    expect(view.runId).toBeUndefined();
    expect(view.script).toBeUndefined();
  });
});

describe('the workflow routes, asked by anything but the page', () => {
  let id: string;
  beforeAll(async () => {
    id = newSession();
    await transcript(id, [call('toolu_g', { script: META }), launched('toolu_g', 'wf_3d3d3d3d-333', 'w20')]);
    await put(id, 'subagents/workflows/wf_3d3d3d3d-333/journal.jsonl', '{"type":"started","key":"v2:a","agentId":"a1","label":"x"}\n');
  });

  it('refuse a request without sign-in, without the mark, from another site or for another host', async () => {
    for (const url of [`/api/sessions/${id}/workflows`, `/api/sessions/${id}/workflows/toolu_g`, `/api/sessions/${id}/workflows/toolu_g/agents/a1`]) {
      expect([url, (await ask(url, { authorization: '' })).status]).toEqual([url, 401]);
      expect([url, (await ask(url, { 'x-pelican': '' })).status]).toEqual([url, 403]);
      expect([url, (await ask(url, { 'sec-fetch-site': 'cross-site' })).status]).toEqual([url, 403]);
      expect([url, (await ask(url, { host: 'evil.example' })).status]).toEqual([url, 403]);
    }
  });

  it('take no encoded separators, backslashes, NULs, double encoding or look-alikes for ids', async () => {
    for (const url of [
      `/api/sessions/${id}/workflows/toolu_g%5C..%5Cx`,
      `/api/sessions/${id}/workflows/toolu_g%00`,
      `/api/sessions/${id}/workflows/toolu_g%252F..`,
      `/api/sessions/${id}/workflows/toolu_g/agents/a1%00`,
      `/api/sessions/${id}/workflows/toolu_g/agents/%2E%2E`,
      `/api/sessions/${id}/workflows/toolu_g/agents/a%E2%81%84b`,
      `/api/sessions/${id}/workflows/toolu_%C9%A1`,
      `/api/sessions/${id.toUpperCase()}x/workflows/toolu_g`,
    ]) {
      expect([url, (await ask(url)).status]).toEqual([url, 404]);
    }
  });

  it('read nothing of another session: not its run by its id, nor its agents by an id that climbs out', async () => {
    const other = newSession();
    await transcript(other, [call('toolu_o', { script: META }), launched('toolu_o', 'wf_4e4e4e4e-444', 'w21')]);
    await put(other, 'workflows/wf_4e4e4e4e-444.json', JSON.stringify({ runId: 'wf_4e4e4e4e-444', taskId: 'w21', status: 'completed', workflowName: 'OTHER-SECRET', workflowProgress: [] }));
    await put(other, 'subagents/workflows/wf_4e4e4e4e-444/agent-a9.meta.json', JSON.stringify({ description: 'OTHER-SECRET' }));
    const mine = newSession();
    await transcript(mine, [call('toolu_m', { script: META }), launched('toolu_m', 'wf_4e4e4e4e-444', 'w22')]);
    await put(mine, 'subagents/workflows/wf_4e4e4e4e-444/journal.jsonl', `${JSON.stringify({ type: 'started', key: 'v2:a', agentId: `x/../../../../../${other}/subagents/workflows/wf_4e4e4e4e-444/agent-a9` })}\n`);
    expect(await (await ask(`/api/sessions/${mine}/workflows/toolu_m`)).text()).not.toContain('OTHER-SECRET');
    expect((await ask(`/api/sessions/${mine}/workflows/toolu_o`)).status).toBe(404);
  });

  it('read no script copy or journal that is a link out of the session’s folder', async () => {
    const linked = newSession();
    await transcript(linked, [call('toolu_s', { scriptPath: '/x/workflows/scripts/demo-review-wf_5f5f5f5f-555.js' }), launched('toolu_s', 'wf_5f5f5f5f-555', 'w23')]);
    await writeFile(path.join(outside, 'secret.js'), META.replace('demo-review', 'LINK-SECRET'));
    await writeFile(path.join(outside, 'journal.jsonl'), '{"type":"started","key":"v2:a","agentId":"a1","label":"LINK-SECRET"}\n');
    await mkdir(path.join(folder(linked), 'workflows', 'scripts'), { recursive: true });
    await mkdir(path.join(folder(linked), 'subagents', 'workflows', 'wf_5f5f5f5f-555'), { recursive: true });
    await symlink(path.join(outside, 'secret.js'), path.join(folder(linked), 'workflows', 'scripts', 'demo-review-wf_5f5f5f5f-555.js'));
    await symlink(path.join(outside, 'journal.jsonl'), path.join(folder(linked), 'subagents', 'workflows', 'wf_5f5f5f5f-555', 'journal.jsonl'));
    expect(await (await ask(`/api/sessions/${linked}/workflows/toolu_s`)).text()).not.toContain('LINK-SECRET');
  });
});

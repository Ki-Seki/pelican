import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AGENTS_SESSION, LICENSES, OUTDATED, OUTDATED_DOING, OUTDATED_FINISHES_MS } from '../src/shared/demo-agents';
import { sessionChanges } from '../src/server/changes';
import { config } from '../src/server/config';
import { demoLiveProcesses, demoRunState, demoRunStatus, demoRunTasks, demoTaskOutput, prepareDemo } from '../src/server/demo';
import { loadMessages, sentFiles } from '../src/server/sessions';
import { readLastTurn } from '../src/server/transcripts';
import { gitStatus } from '../src/server/workspace';
import { subagentPage, workflowAgentPage, workflowView } from '../src/server/workflows';
import { agentOf, buildItems, type ToolCall } from '../src/web/lib/turns';

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

  it('a picture Claude sent, as Claude Code records it delivered, at the path where the demo keeps it', async () => {
    const rows = await rowsOf(transcriptOf('acme-web', DEV));
    const recorded = rows.find((row) => row.toolUseResult?.attachments)?.toolUseResult;
    const file = path.join(config.home, 'code', 'acme-web', 'screenshots', 'settings-dark.png');
    expect(recorded).toMatchObject({ caption: 'The settings page in the dark theme', attachments: [{ path: file, isImage: true, media_type: 'image/png', pathValidated: true }] });
    expect((await stat(file)).size).toBe(recorded.attachments[0].size);
    expect((await readFile(file)).subarray(1, 4).toString()).toBe('PNG');
    expect([...(await sentFiles(DEV))]).toEqual([file]);
    // Taken after the repository's last commit: a new file there.
    const status = await gitStatus(path.join(config.home, 'code', 'acme-web'));
    expect(status.repo && status.files.find((f) => f.path === 'screenshots/settings-dark.png')?.status).toBe('untracked');
  });

  it('a session waiting for an answer in the terminal, beside the one at work in Claude Desktop', () => {
    const live = demoLiveProcesses();
    expect(live.get(WAITING)).toMatchObject({ app: 'the terminal', busy: true, waiting: 'permission prompt' });
    expect([...live.values()].some((p) => p.app === 'Claude Desktop' && p.busy && !p.waiting)).toBe(true);
  });
});

describe('the demo’s list', () => {
  it('has one session pinned, in the demo’s own state folder: the list shows its Pinned group', async () => {
    const RELEASE_NOTES = 'd1e4c7f3-4444-4d4e-bf60-000000000004';
    const { pinnedIds } = await import('../src/server/pinned');
    expect([...await pinnedIds()]).toEqual([RELEASE_NOTES]);
    expect(path.relative(config.home, config.stateDir)).toBe('state');
    expect(JSON.parse(await readFile(path.join(config.stateDir, 'pinned.json'), 'utf8'))).toEqual({ ids: [RELEASE_NOTES] });
  });
});

const SLOW = 'b7e2a9c1-2222-4b2c-9d4e-000000000002';
const SIDE = 'a3f1c2d4-1111-4a1b-8c3d-0000000000a1';
const transcriptOf = (project: string, id: string) => path.join(config.claudeHome, 'projects', path.join(config.home, 'code', project).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const rowsOf = async (file: string) => (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>);

/** Every file under a folder, its git folder left out. */
async function filesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesIn(full));
    else out.push(full);
  }
  return out;
}

describe('the demo’s folders', () => {
  it('hold files with text in them, as the conversations show them', async () => {
    const files = await filesIn(path.join(config.home, 'code'));
    expect(files.length).toBeGreaterThan(10);
    const empty = [];
    for (const file of files) if ((await stat(file)).size === 0) empty.push(path.relative(config.home, file));
    expect(empty).toEqual([]);
  });

  it('hold the export the slow-export session reads, with its loop where the session finds it', async () => {
    const lines = (await readFile(path.join(config.home, 'code', 'data-pipeline', 'pipeline', 'export.py'), 'utf8')).split('\n');
    expect(lines.slice(34, 38)).toEqual(['def export_rows(batch):', '    for row in batch:', '        owner = db.fetch_owner(row.owner_id)', '        write(row, owner)']);
    const rows = await rowsOf(transcriptOf('data-pipeline', SLOW));
    const blocks = rows.flatMap((row) => (Array.isArray(row.message?.content) ? row.message.content : []));
    const call = blocks.find((b: any) => b.type === 'tool_use' && b.name === 'Read');
    expect(call.input.offset).toBe(35);
    // What the Read shows is the file from that line on, numbered as the file is.
    const shown = blocks.find((b: any) => b.type === 'tool_result' && b.tool_use_id === call.id).content as string;
    expect(shown.split('\n').slice(0, 4)).toEqual(lines.slice(34, 38).map((line, i) => `${String(35 + i).padStart(6)}\t${line}`));
    expect(blocks.find((b: any) => b.type === 'tool_result' && String(b.content).startsWith('pipeline/export.py:')).content).toBe('pipeline/export.py:35:def export_rows(batch):');
  });

  it('keep a remote for the repository, as one you push from has: Push and Create PR show as they would', async () => {
    const status = await gitStatus(path.join(config.home, 'code', 'acme-web'));
    expect(status.repo && status.remote).toBe(true);
  });
});

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

  it('whose agents made as many tool calls as their steps show, and the runs as many as their agents', async () => {
    const runs = [
      { call: 'toolu_demo_wf_review', workflow: (await workflowView(WORKFLOWS, 'toolu_demo_wf_review'))!.workflow },
      { call: 'toolu_demo_wf_fixes', workflow: demoRunState(WORKFLOWS)!.workflows!.toolu_demo_wf_fixes! },
    ];
    for (const { call, workflow } of runs) {
      for (const agent of workflow.agents) {
        const page = await workflowAgentPage(WORKFLOWS, call, agent.agentId!, {});
        const calls = page!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use').length;
        expect([agent.label, agent.toolCalls]).toEqual([agent.label, calls]);
      }
      expect(workflow.totalToolCalls).toBe(workflow.agents.reduce((sum, a) => sum + (a.toolCalls ?? 0), 0));
    }
    // The agent at work is at the step its row names.
    const working = runs[1]!.workflow.agents.find((a) => a.state === 'progress')!;
    const page = await workflowAgentPage(WORKFLOWS, 'toolu_demo_wf_fixes', working.agentId!, {});
    const last = page!.messages.at(-1)!.blocks.at(-1)!;
    expect([last.type, last.type === 'tool_use' ? last.name : undefined]).toEqual(['tool_use', working.lastToolName]);
  });
});

describe('the demo shows agents Claude left working in the background', () => {
  const callsIn = (messages: Awaited<ReturnType<typeof loadMessages>>): ToolCall[] =>
    buildItems(messages).flatMap((i) => (i.kind === 'assistant' ? i.parts : [])).flatMap((p) => (p.kind === 'tool' ? [p.call] : []));

  it('one finished, its report handed back and Claude Code’s notice of its end in the conversation; one at work, in the session’s run', async () => {
    const rows = await rowsOf(transcriptOf('acme-web', AGENTS_SESSION));
    // Each launch as Claude Code records it, next to its words for the model alone.
    expect(rows.filter((row) => row.toolUseResult?.status === 'async_launched').map((row) => row.toolUseResult.agentId)).toEqual([LICENSES.agentId, OUTDATED.agentId]);
    expect(rows.find((row) => row.isMeta && row.origin?.handback)?.origin).toMatchObject({ kind: 'peer', from: LICENSES.agentId, handbackReportText: LICENSES.report });
    const [licenses, outdated] = callsIn(await loadMessages(AGENTS_SESSION));
    expect(agentOf(licenses!)).toEqual({ background: true, mode: 'background', agentId: LICENSES.agentId });
    expect(licenses?.ended).toMatchObject({ status: 'completed', usage: { toolUses: LICENSES.usage.toolUses, durationMs: LICENSES.usage.durationMs } });
    expect(licenses?.report).toBe(LICENSES.report);
    expect(outdated?.ended).toBeUndefined();
    const run = demoRunState(AGENTS_SESSION);
    expect(run?.tasks).toEqual([{ id: OUTDATED.agentId, description: OUTDATED.description, type: 'general-purpose', summary: OUTDATED_DOING, toolUseId: OUTDATED.call }]);
    expect(run?.progress?.[OUTDATED.call]).toMatchObject({ summary: OUTDATED_DOING, lastTool: 'Read' });
    expect(demoRunStatus(AGENTS_SESSION)).toBe('idle');
    expect(demoRunTasks(AGENTS_SESSION)).toBe(1);
  });

  it('whose agents made as many tool calls as their figures say, the one at work on the step its progress names', async () => {
    const calls = (page: Awaited<ReturnType<typeof subagentPage>>) => page!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use');
    expect(calls(await subagentPage(AGENTS_SESSION, LICENSES.agentId, {})).length).toBe(LICENSES.usage.toolUses);
    const working = await subagentPage(AGENTS_SESSION, OUTDATED.agentId, {});
    const progress = demoRunState(AGENTS_SESSION)!.progress![OUTDATED.call]!;
    expect(calls(working).length).toBe(progress.toolUses);
    const last = working!.messages.at(-1)!.blocks.at(-1)!;
    expect([last.type, last.type === 'tool_use' ? last.name : undefined]).toEqual(['tool_use', progress.lastTool]);
    // What is new since a message, as its card asks for it while the agent works.
    const since = await subagentPage(AGENTS_SESSION, OUTDATED.agentId, { after: working!.total - 2 });
    expect([since!.offset, since!.messages.map((m) => m.uuid)]).toEqual([working!.total - 2, working!.messages.slice(-2).map((m) => m.uuid)]);
  });
});

describe('in the demo’s page', async () => {
  // The page's own address, as in a browser.
  Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
  const { startDemo } = await import('../src/web/lib/demo');
  const { api } = await import('../src/web/lib/api');
  const { getView, setRun } = await import('../src/web/lib/store');
  beforeAll(() => startDemo({ machine: 'laptop', home: '/demo', version: '0', auth: false, demo: true }));

  it('Stop on the command Claude left running ends it, and the session has nothing left at work', async () => {
    setRun(DEV, demoRunState(DEV)!);
    await expect(api.stopTask(DEV, 'bash_1')).resolves.toEqual({ ok: true });
    expect(getView(DEV).run?.tasks).toBeUndefined();
    expect(getView(DEV).run?.busy).toBe(false);
  });

  it('Stop on the agent at work stops it, and Claude Code’s notice that you stopped it goes into the conversation', async () => {
    setRun(AGENTS_SESSION, demoRunState(AGENTS_SESSION)!);
    await expect(api.stopTask(AGENTS_SESSION, OUTDATED.agentId)).resolves.toEqual({ ok: true });
    const view = getView(AGENTS_SESSION);
    expect(view.run?.tasks).toBeUndefined();
    expect(view.run?.progress).toBeUndefined();
    const items = buildItems(view.messages);
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: `Agent "${OUTDATED.description}" was stopped by user` });
  });

  it('the agent at work finishes a while after its session is first opened: its report, the notice of its end, Claude’s answer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ session: null, run: demoRunState(AGENTS_SESSION) }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      setRun(AGENTS_SESSION, demoRunState(AGENTS_SESSION)!);
      const before = getView(AGENTS_SESSION).messages.length;
      await api.session(AGENTS_SESSION);
      await vi.advanceTimersByTimeAsync(OUTDATED_FINISHES_MS - 1000);
      expect(getView(AGENTS_SESSION).run?.tasks?.map((t) => t.id)).toEqual([OUTDATED.agentId]);
      await vi.advanceTimersByTimeAsync(5000);
      const view = getView(AGENTS_SESSION);
      expect(view.run?.tasks).toBeUndefined();
      expect(view.run?.busy).toBe(false);
      const added = view.messages.slice(before);
      expect(added.map((m) => [m.role, Boolean(m.meta)])).toEqual([['user', true], ['user', false], ['assistant', false]]);
      expect(added[0]?.handback).toEqual({ from: OUTDATED.agentId, report: OUTDATED.report });
      expect(buildItems(added).filter((i) => i.kind === 'notice')).toMatchObject([{ text: `Agent "${OUTDATED.description}" finished` }]);
      expect(added[2]?.blocks[0]).toMatchObject({ type: 'text', text: OUTDATED.reply });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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

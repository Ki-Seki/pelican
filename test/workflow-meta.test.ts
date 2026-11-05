import { describe, expect, it } from 'vitest';

import type { WorkflowAgent } from '../src/shared/protocol';
import {
  agentStatus, durationText, launchOf, parseMeta, parseTaskNotice, phaseGroups, scriptName, tokensText, unframedPrompt, workflowOf,
} from '../src/shared/workflows';

const META = `export const meta = {
  name: 'demo-review',
  description: 'Review the demo app in two areas, then have a skeptic check each finding',
  phases: [
    { title: 'Review', detail: 'one agent per area' },
    { title: 'Verify', detail: 'a skeptic re-checks each finding' },
  ],
}

const results = await pipeline(['server', 'client'], (area) => agent(\`Review \${area}\`))
return results
`;

describe('a workflow script’s meta', () => {
  it('is read as a literal, phases with their details', () => {
    expect(parseMeta(META)).toEqual({
      name: 'demo-review',
      description: 'Review the demo app in two areas, then have a skeptic check each finding',
      phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify', detail: 'a skeptic re-checks each finding' }],
    });
  });

  it('takes the quotes, escapes, comments and joined strings scripts are written with', () => {
    const meta = parseMeta([
      '// The release review.',
      '/* two phases */ export const meta = {',
      '  "name": "fix-\\u{1F600}",',
      "  description: 'Fix what the review found, ' +",
      '    "then check it " + `again`,',
      "  phases: [{ title: 'Fix\\tit', detail: 'one agent per finding\\n(at most 16)', }, { title: `Re\\x63heck` },],",
      "  whenToUse: 'after a review',",
      '}',
    ].join('\n'));
    expect(meta).toEqual({
      name: 'fix-😀',
      description: 'Fix what the review found, then check it again',
      phases: [{ title: 'Fix\tit', detail: 'one agent per finding\n(at most 16)' }, { title: 'Recheck' }],
      whenToUse: 'after a review',
    });
  });

  it('is not there when the script does not start with one Claude Code would take', () => {
    expect(parseMeta('const meta = { name: "x" }')).toBeUndefined();
    expect(parseMeta('export const meta = { name: NAME }')).toBeUndefined();
    expect(parseMeta('export const meta = { name: `review-${area}` }')).toBeUndefined();
    expect(parseMeta('export const meta = { name: "x", phases: PHASES.map((p) => p) }')).toBeUndefined();
    expect(parseMeta('export const meta = { name: "unclosed')).toBeUndefined();
    expect(parseMeta('export const meta = { name: "line\nbreak" }')).toBeUndefined();
    expect(parseMeta('')).toBeUndefined();
  });

  it('is looked for in the start of a script only, and nested only so deep', () => {
    expect(parseMeta(`export const meta = { name: 'big', description: '${'x'.repeat(20_000)}' }`)).toBeUndefined();
    expect(parseMeta(`export const meta = { a: ${'['.repeat(12)}${']'.repeat(12)} }`)).toBeUndefined();
  });

  it('gives a key named like the object’s own machinery no say', () => {
    const meta = parseMeta("export const meta = { __proto__: { polluted: true }, constructor: 'x', name: 'safe' }");
    expect(meta?.name).toBe('safe');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('names a call by its meta, a predefined workflow, or the script file it runs', () => {
    expect(workflowOf({ script: META })).toMatchObject({ name: 'demo-review', description: expect.stringMatching(/^Review the demo app/) });
    expect(workflowOf({ name: 'spec' })).toEqual({ name: 'spec' });
    expect(workflowOf({ scriptPath: '/h/.claude/projects/p/s/workflows/scripts/demo-review-wf_7c2e4a10-9b3.js' })).toMatchObject({ name: 'demo-review' });
    expect(scriptName('my-own.js')).toBe('my-own');
  });

  it('names a call still streaming in by what of its meta has come', () => {
    expect(workflowOf({ script: "export const meta = {\n  name: 'demo-review',\n  description: 'Review the demo" })).toEqual({ name: 'demo-review' });
    expect(workflowOf({ script: "export const meta = {\n  name: 'demo-review',\n  description: 'Review it',\n  phases: [" })).toEqual({ name: 'demo-review', description: 'Review it' });
  });
});

describe('what a Workflow call launched', () => {
  const text = 'Workflow launched in background. Task ID: w4k9qz2mx\nSummary: Review the demo\nTranscript dir: /x\nScript file: /h/s/workflows/scripts/demo-review-wf_7c2e4a10-9b3.js\nRun ID: wf_7c2e4a10-9b3\n\nYou will be notified when it completes.';
  it('comes from what Claude Code recorded, or else from its words', () => {
    expect(launchOf({ type: 'tool_result', tool_use_id: 't', content: 'x', workflow: { runId: 'wf_7c2e4a10-9b3', taskId: 'w1' } })).toEqual({ runId: 'wf_7c2e4a10-9b3', taskId: 'w1' });
    expect(launchOf({ type: 'tool_result', tool_use_id: 't', content: text })).toEqual({
      runId: 'wf_7c2e4a10-9b3', taskId: 'w4k9qz2mx', summary: 'Review the demo', scriptFile: 'demo-review-wf_7c2e4a10-9b3.js',
    });
  });

  it('is nothing for a script that did not compile, or a result of another tool', () => {
    expect(launchOf({ type: 'tool_result', tool_use_id: 't', content: 'Workflow script has a syntax error and was not launched:\nx', is_error: true })).toBeUndefined();
    expect(launchOf({ type: 'tool_result', tool_use_id: 't', content: 'a.txt' })).toBeUndefined();
    expect(launchOf(undefined)).toBeUndefined();
  });
});

describe('Claude Code’s notice of a task’s end', () => {
  it('says which call it ends, how, with the run’s figures', () => {
    const notice = parseTaskNotice([
      '<task-notification>',
      '<task-id>w4k9qz2mx</task-id>',
      '<tool-use-id>toolu_1</tool-use-id>',
      '<output-file>/tmp/claude-501/p/s/tasks/w4k9qz2mx.output</output-file>',
      '<status>completed</status>',
      '<summary>Dynamic workflow "Review &amp; fix" completed</summary>',
      '<result>[{"verdicts":[]}]</result>',
      '<usage><agent_count>4</agent_count><agents_done>4</agents_done><agents_error>0</agents_error><agents_skipped>0</agents_skipped><subagent_tokens>412300</subagent_tokens><tool_uses>87</tool_uses><duration_ms>361250</duration_ms></usage>',
      '</task-notification>',
    ].join('\n'));
    expect(notice).toEqual({
      taskId: 'w4k9qz2mx', toolUseId: 'toolu_1', status: 'completed', summary: 'Dynamic workflow "Review & fix" completed', result: '[{"verdicts":[]}]',
      usage: { agents: 4, done: 4, failed: 0, skipped: 0, tokens: 412_300, toolUses: 87, durationMs: 361_250 },
    });
  });

  it('says apart why a run failed, its escapes undone', () => {
    const notice = parseTaskNotice('<task-notification>\n<tool-use-id>toolu_2</tool-use-id>\n<output-file>/x</output-file>\n<status>failed</status>\n<summary>Dynamic workflow "Sort" failed: TypeError: x\n    at &lt;anonymous&gt; (workflow.js:12:20)</summary>\n</task-notification>');
    expect(notice).toMatchObject({ status: 'failed', summary: 'Dynamic workflow "Sort" failed', error: 'TypeError: x\n    at <anonymous> (workflow.js:12:20)' });
  });

  it('knows one from a Claude Code that found the task without its end', () => {
    const notice = parseTaskNotice('<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>toolu_3</tool-use-id>\n<status>stopped</status>\n<summary>Background workflow "docs" (run wf_3c4d5e6f-a0b) didn\'t finish before the previous session ended</summary>\n<note>No completion record was found for it.</note>\n</task-notification>');
    expect(notice).toMatchObject({ status: 'stopped', orphan: true });
    expect(parseTaskNotice('Not a notice')).toBeUndefined();
  });
});

const agent = (index: number, extra: Partial<WorkflowAgent>): WorkflowAgent => ({ index, label: `agent ${index}`, state: 'progress', startedAt: 1, ...extra });

describe('agents and phases, by the CLI’s rules', () => {
  it('tells each agent’s state, and stops what a run that ended left unfinished', () => {
    expect(agentStatus(agent(1, { state: 'done' }), 'running')).toBe('done');
    expect(agentStatus(agent(1, { state: 'start', queuedAt: 1, startedAt: undefined }), 'running')).toBe('queued');
    expect(agentStatus(agent(1, { state: 'progress' }), 'running')).toBe('running');
    expect(agentStatus(agent(1, { state: 'progress' }), 'killed')).toBe('stopped');
    expect(agentStatus(agent(1, { state: 'error', error: 'Stopped because the workflow was stopped' }), 'killed')).toBe('stopped');
    expect(agentStatus(agent(1, { state: 'error', error: 'API Error: 529' }), 'failed')).toBe('failed');
    expect(agentStatus(agent(1, { state: 'error', error: 'skipped by user', skipped: true }), 'running')).toBe('skipped');
    expect(agentStatus(agent(1, { state: 'error', error: '[x] blocked by safety classifier: no', blocked: true }), 'running')).toBe('blocked');
  });

  it('groups agents into the script’s phases in order, by title as the run names them, then the rest', () => {
    const groups = phaseGroups({
      status: 'running',
      phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify' }, { title: 'Report' }],
      agents: [
        agent(3, { phaseTitle: 'verify', state: 'progress' }),
        agent(1, { phaseTitle: 'Review all', state: 'done' }),
        agent(2, { phaseTitle: 'Review', state: 'error', error: 'API Error' }),
        agent(4, { phaseTitle: 'Cleanup', state: 'done' }),
        agent(5, { phaseIndex: 7, state: 'done' }),
        agent(6, { state: 'done' }),
      ],
    });
    expect(groups.map((g) => [g.title, g.agents.map((a) => a.index), g.status, g.done, g.failed])).toEqual([
      ['Review', [1, 2], 'failed', 1, 1],
      ['Verify', [3], 'running', 0, 0],
      ['Report', [], 'pending', 0, 0],
      ['Cleanup', [4], 'done', 1, 0],
      ['Phase 7', [5], 'done', 1, 0],
      ['Other agents', [6], 'done', 1, 0],
    ]);
    expect(phaseGroups({ status: 'completed', phases: [], agents: [agent(1, { state: 'done' })] }).map((g) => g.title)).toEqual(['Agents']);
  });

  it('writes tokens and times as Claude Code does', () => {
    expect([950, 1000, 1049, 412_300, 999_949, 999_950, 2_803_981].map(tokensText)).toEqual(['950', '1k', '1k', '412.3k', '999.9k', '1m', '2.8m']);
    expect([0, 45_000, 361_250, 3_785_000].map(durationText)).toEqual(['0s', '45s', '6m 1s', '1h 3m 5s']);
  });

  it('shows an agent’s prompt without the frame the harness puts around it', () => {
    const framed = '[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n  Review the server.\n    Look at login.ts.';
    expect(unframedPrompt(framed)).toBe('Review the server.\n  Look at login.ts.');
    expect(unframedPrompt('Just a prompt')).toBe('Just a prompt');
  });
});

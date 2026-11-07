// An Agent call that Claude did not wait for, as the transcript and the stream carry it: how it
// began, and the report its agent handed back, Claude Code's own message, never one you sent.
// Made-up content in Claude Code's shapes.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readHistory } from '../src/server/history';
import { handbackOf, toChatMessage } from '../src/server/normalize';

const AGENT = 'a1b2c3d4e5f6a7b8c';
const LAUNCH = `Async agent launched successfully. (This tool result is internal metadata \u2014 never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${AGENT} (internal ID - do not mention to user.)\noutput_file: /tmp/x/${AGENT}.output`;

describe('toChatMessage: what Claude Code records of an Agent call it did not wait for', () => {
  const content = [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: LAUNCH }];
  it('keeps how it began, from a transcript or from the stream, and nothing of the kind for a workflow or another tool', () => {
    const output = { isAsync: true, status: 'async_launched', agentId: AGENT, description: 'Look', prompt: 'Find them.', outputFile: '/tmp/x.output' };
    for (const key of ['toolUseResult', 'tool_use_result']) {
      expect(toChatMessage({ type: 'user', uuid: 'r', [key]: output, message: { role: 'user', content } })?.blocks[0]).toMatchObject({ agent: { mode: 'background', agentId: AGENT } });
    }
    expect(toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { status: 'remote_launched', taskId: 'r1', sessionUrl: 'https://claude.ai/code/session_1' }, message: { role: 'user', content } })?.blocks[0])
      .toMatchObject({ agent: { mode: 'cloud', sessionUrl: 'https://claude.ai/code/session_1' } });
    expect(toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { status: 'remote_launched', sessionUrl: 'javascript:alert(1)' }, message: { role: 'user', content } })?.blocks[0])
      .toMatchObject({ agent: { mode: 'cloud' } });
    const workflow = toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { status: 'async_launched', taskId: 'w1', taskType: 'local_workflow', runId: 'wf_7c2e4a10-9b3' }, message: { role: 'user', content } });
    expect(workflow?.blocks[0]).not.toHaveProperty('agent');
    expect(toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { ...output, agentId: '../x' }, message: { role: 'user', content } })?.blocks[0]).not.toHaveProperty('agent');
    expect(toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { status: 'completed', agentId: AGENT }, message: { role: 'user', content } })?.blocks[0]).not.toHaveProperty('agent');
  });
});

describe('a report a subagent handed back', () => {
  const frame = (report: string) => `Another Claude session sent a message:\n<agent-message from="${AGENT}">\n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n${report.split('\n').map((l) => `  ${l}`).join('\n')}\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.`;
  const report = 'All clear.\n\n- one\n  - nested';

  it('is Claude Code’s message, not yours: which agent, and its words, from Claude Code’s copy or out of its frame', () => {
    const origin = { kind: 'peer', from: AGENT, senderTaskId: AGENT, name: 'general-purpose', handback: true };
    const copied = toChatMessage({ type: 'user', uuid: 'h', isMeta: true, origin: { ...origin, handbackReportText: report }, message: { role: 'user', content: frame(report) } });
    expect(copied).toMatchObject({ meta: true, handback: { from: AGENT, report } });
    const framed = toChatMessage({ type: 'user', uuid: 'h', isMeta: true, origin, message: { role: 'user', content: frame(report) } });
    expect(framed?.handback).toEqual({ from: AGENT, report });
    expect(handbackOf({ origin: { ...origin, body: `[Subagent hand-back] The report follows:\n${report.split('\n').map((l) => `  ${l}`).join('\n')}` } }, '')).toEqual({ from: AGENT, report });
  });

  it('is not one without Claude Code’s mark: a message you typed with the same words is yours', () => {
    const typed = toChatMessage({ type: 'user', uuid: 'h', message: { role: 'user', content: frame(report) } });
    expect(typed?.handback).toBeUndefined();
    expect(typed?.meta).toBeUndefined();
    expect(handbackOf({ origin: { kind: 'human' } }, frame(report))).toBeUndefined();
    expect(handbackOf({ origin: { kind: 'peer', from: '../x', handback: true, handbackReportText: report } }, '')).toBeUndefined();
  });

  describe('read from a transcript', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-handback-'));
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it('as a row of its own, or come while Claude worked as a queued command: Claude Code’s message either way, never a prompt you sent', async () => {
      const file = path.join(dir, 'handback.jsonl');
      const origin = { kind: 'peer', from: AGENT, senderTaskId: AGENT, handback: true, handbackReportText: report };
      await writeFile(file, [
        JSON.stringify({ uuid: 'u1', parentUuid: null, type: 'user', timestamp: '2026-11-05T00:00:00.000Z', message: { role: 'user', content: 'Look for flaky tests' } }),
        JSON.stringify({ uuid: 'h1', parentUuid: 'u1', type: 'user', isMeta: true, origin, timestamp: '2026-11-05T00:01:00.000Z', message: { role: 'user', content: frame(report) } }),
        JSON.stringify({
          uuid: 'q1', parentUuid: 'h1', type: 'attachment', timestamp: '2026-11-05T00:02:00.000Z',
          attachment: { type: 'queued_command', prompt: frame('Second report.'), commandMode: 'prompt', isMeta: true, origin: { ...origin, handbackReportText: 'Second report.' }, source_uuid: 's1' },
        }),
        JSON.stringify({ uuid: 'a1', parentUuid: 'q1', type: 'assistant', timestamp: '2026-11-05T00:03:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Both are in.' }] } }),
      ].join('\n') + '\n');
      const messages = await readHistory(file);
      expect(messages.map((m) => [m.uuid, Boolean(m.meta), m.handback?.report, Boolean(m.steered)])).toEqual([
        ['u1', false, undefined, false],
        ['h1', true, report, false],
        ['q1', true, 'Second report.', false],
        ['a1', false, undefined, false],
      ]);
    });
  });
});

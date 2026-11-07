import type { RunState } from '../shared/protocol.js';
import {
  AGENTS_SESSION, agentNotice, type DemoAgent, handbackOrigin, handbackText, launched, launchText, LICENSES, OUTDATED, OUTDATED_DOING,
} from '../shared/demo-agents.js';
import type { DemoSession, Row } from './demo.js';

/**
 * The demo's background agents: a session in which Claude checks the dependencies before a release
 * with two agents it does not wait for. One has finished, its report handed back and Claude Code's
 * notice of its end in the conversation; the other still works, in the session's run, which
 * Claude stays running for. Each agent's own transcript is written next to the session's, as
 * Claude Code writes it, all made up, with times relative to now.
 */

const MIN = 60_000;

type Block = Record<string, unknown>;
const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string): Block => ({ type: 'tool_result', tool_use_id: id, content });
const text = (value: string): Block => ({ type: 'text', text: value });

type Step = { at: number; role: 'user' | 'assistant'; content: Block[] };

/** The steps each agent took: the one done, to its hand-back; the one at work, to the step it is on. */
function steps(cwd: string): Record<string, Step[]> {
  return {
    [LICENSES.agentId]: [
      { at: 3_000, role: 'assistant', content: [tool('l1', 'Read', { file_path: `${cwd}/package.json` })] },
      { at: 4_000, role: 'user', content: [result('l1', '     1\t{\n     2\t  "name": "acme-web",\n     3\t  "version": "1.4.0",\n     4\t  "private": true,\n     5\t  "type": "module",')] },
      { at: 20_000, role: 'assistant', content: [tool('l2', 'Bash', { command: 'npx --yes license-checker --summary', description: 'Count the packages by license' })] },
      { at: 61_000, role: 'user', content: [result('l2', '├─ MIT: 186\n├─ ISC: 21\n├─ Apache-2.0: 9\n├─ BSD-3-Clause: 4\n├─ BSD-2-Clause: 3\n└─ BlueOak-1.0.0: 2')] },
      { at: 75_000, role: 'assistant', content: [tool('l3', 'Bash', { command: 'npx --yes license-checker --onlyAllow "MIT;ISC;Apache-2.0;BSD-3-Clause;BSD-2-Clause"', description: 'List what is outside the allowed licenses' })] },
      { at: 98_000, role: 'user', content: [result('l3', 'Package "path-scurry@2.0.0" is licensed under "BlueOak-1.0.0" which is not permitted by the --onlyAllow flag. Exiting.')] },
      { at: 126_000, role: 'assistant', content: [text('BlueOak-1.0.0 is permissive, so the release can ship with every license here.'), tool('l4', 'SubagentHandback', { message: LICENSES.report })] },
      { at: 127_000, role: 'user', content: [result('l4', '{"success":true,"message":"Report delivered to your caller."}')] },
    ],
    [OUTDATED.agentId]: [
      { at: 4_000, role: 'assistant', content: [tool('o1', 'Read', { file_path: `${cwd}/package.json` })] },
      { at: 5_000, role: 'user', content: [result('o1', '     8\t  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },\n     9\t  "devDependencies": { "@playwright/test": "^1.56.0", "vite": "^7.1.4" }')] },
      { at: 30_000, role: 'assistant', content: [tool('o2', 'Bash', { command: 'npm outdated', description: 'List the packages behind their latest version' })] },
      { at: 52_000, role: 'user', content: [result('o2', 'Package           Current  Wanted  Latest\n@playwright/test   1.56.0  1.56.1  1.57.0\nvite                7.1.4  7.1.12   7.2.2')] },
      { at: 90_000, role: 'assistant', content: [tool('o3', 'Bash', { command: 'npm view vite@7.2.2 engines peerDependencies --json', description: 'See what vite 7.2 needs' })] },
      { at: 101_000, role: 'user', content: [result('o3', '{\n  "engines": { "node": "^20.19.0 || >=22.12.0" },\n  "peerDependencies": { "@types/node": "^20.19.0 || >=22.12.0" }\n}')] },
      { at: 170_000, role: 'assistant', content: [tool('o4', 'Grep', { pattern: 'defineConfig|server\\.', path: `${cwd}/src` })] },
      { at: 172_000, role: 'user', content: [result('o4', 'No matches found')] },
      { at: 240_000, role: 'assistant', content: [tool('o5', 'Bash', { command: 'npx --yes @playwright/test@1.57.0 --version', description: 'Check the new Playwright runs here' })] },
      { at: 262_000, role: 'user', content: [result('o5', 'Version 1.57.0')] },
      // At work on it now: the step its progress names, not answered yet.
      { at: 300_000, role: 'assistant', content: [tool('o6', 'Read', { file_path: `${cwd}/tests/login.spec.ts` })] },
    ],
  };
}

/** An agent's own transcript, as Claude Code writes one: a side chain, beginning with what it was asked. */
function agentTranscript(agent: DemoAgent, cwd: string, start: number, own: Step[]): string {
  let parent: string | null = null;
  const lines: string[] = [];
  const row = (uuid: string, type: 'user' | 'assistant', message: Record<string, unknown>, at: number) => {
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: true, agentId: agent.agentId, type, message, uuid, timestamp: new Date(at).toISOString(), userType: 'external', cwd, sessionId: AGENTS_SESSION, version: '2.1.318' }));
    parent = uuid;
  };
  row(`${agent.agentId}-0`, 'user', { role: 'user', content: agent.prompt }, start);
  own.forEach((step, i) => {
    row(`${agent.agentId}-${i + 1}`, step.role, step.role === 'assistant'
      ? { id: `msg_demo_${agent.agentId}_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: step.content }
      : { role: 'user', content: step.content }, start + step.at);
  });
  return `${lines.join('\n')}\n`;
}

/** Claude Code's file of what it knows of an agent, next to its transcript. */
const meta = (agent: DemoAgent, finished: boolean) => JSON.stringify({
  agentType: 'general-purpose', isBuiltIn: true, launchedWithDefaults: true, description: agent.description, toolUseId: agent.call,
  spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, pickedEffortModel: 'claude-opus-5-5', ...(finished ? { finished: true } : {}),
});

/** When the request came and the agents started: set once, when the demo starts. */
let started: { asked: number; launched: number } | undefined;
function times() {
  if (!started) {
    const asked = Date.now() - 9 * MIN;
    started = { asked, launched: asked + 5_000 };
  }
  return started;
}

/** The session itself: the request, the two agents launched, the one that finished and what Claude made of it. */
export const AGENTS_DEMO: DemoSession = {
  id: AGENTS_SESSION,
  title: 'Check the dependencies before the release',
  project: 'acme-web',
  branch: 'chore/deps',
  rows: () => {
    const { asked, launched: at } = times();
    const done = at + LICENSES.usage.durationMs;
    const rows: Row[] = [
      { role: 'user', at: asked, content: 'Before the release, check our dependencies: are the licenses all fine, and is anything out of date? Do both in the background.' },
      {
        role: 'assistant',
        at: asked + 4_000,
        content: [
          text('I’ll run two agents in the background, one for the licenses and one for what is out of date.'),
          tool(LICENSES.call, 'Agent', { description: LICENSES.description, subagent_type: 'general-purpose', prompt: LICENSES.prompt, run_in_background: true }),
          tool(OUTDATED.call, 'Agent', { description: OUTDATED.description, subagent_type: 'general-purpose', prompt: OUTDATED.prompt, run_in_background: true }),
        ],
      },
      // Each result in a row of its own, as Claude Code writes them, with what it records of it.
      { role: 'user', at, content: [result(LICENSES.call, launchText(LICENSES))], result: launched(LICENSES) },
      { role: 'user', at: at + 200, content: [result(OUTDATED.call, launchText(OUTDATED))], result: launched(OUTDATED) },
      { role: 'assistant', at: at + 3_000, content: [text('Both are working in the background. I’ll tell you what each one finds when it is done.')] },
      // The report the licenses agent handed back, then Claude Code's notice of its end.
      { role: 'user', at: done - 1_000, content: handbackText(LICENSES), extra: { isMeta: true, origin: handbackOrigin(LICENSES) } },
      { role: 'user', at: done, content: agentNotice(LICENSES, 'completed', LICENSES.usage), extra: { origin: { kind: 'task-notification', producer: 'session-task' } } },
      { role: 'assistant', at: done + 9_000, content: [text(LICENSES.reply)] },
    ];
    return rows;
  },
  files: (cwd) => {
    const { launched: at } = times();
    const own = steps(cwd);
    return {
      [`subagents/agent-${LICENSES.agentId}.jsonl`]: agentTranscript(LICENSES, cwd, at, own[LICENSES.agentId]!),
      [`subagents/agent-${LICENSES.agentId}.meta.json`]: meta(LICENSES, true),
      [`subagents/agent-${OUTDATED.agentId}.jsonl`]: agentTranscript(OUTDATED, cwd, at + 200, own[OUTDATED.agentId]!),
      [`subagents/agent-${OUTDATED.agentId}.meta.json`]: meta(OUTDATED, false),
    };
  },
};

/** The steps the agent at work has made so far, as its progress counts them: the one it is on included. */
export const OUTDATED_STEPS_SO_FAR = 6;

/** The session's run: Claude is done with its turn, and the outdated check works on in the background. */
export function demoAgentsRun(sessionId: string, cwd: string): RunState | undefined {
  if (sessionId !== AGENTS_SESSION) return undefined;
  const { launched: at } = times();
  return {
    sessionId,
    cwd,
    busy: false,
    settings: { model: 'default', effort: 'high', permissionMode: 'default' },
    partial: [],
    permissions: [],
    tasks: [{ id: OUTDATED.agentId, description: OUTDATED.description, type: 'general-purpose', summary: OUTDATED_DOING, toolUseId: OUTDATED.call }],
    progress: { [OUTDATED.call]: { summary: OUTDATED_DOING, lastTool: 'Read', toolUses: OUTDATED_STEPS_SO_FAR, durationMs: Math.max(0, Date.now() - at - 200) } },
    lastTurn: { durationMs: 9_000, outputTokens: 214 },
    context: { percent: 14, tokens: 28_000, max: 200_000 },
  };
}

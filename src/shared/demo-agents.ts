/**
 * The demo's background agents, made up, in the shapes Claude Code writes them: the session in
 * which Claude checks the dependencies with two agents it does not wait for (src/server/demo-agents.ts
 * writes it), and what the web app's demo plays out when the one still at work finishes, or is
 * stopped (src/web/lib/demo.ts). Both demos, `pelican --demo` and the site's, show it.
 */

export const AGENTS_SESSION = 'c2d5f8b1-dddd-4c2d-9e3f-000000000014';

export type DemoAgent = {
  /** The Agent call, and the agent's own id: its transcript and its task. */
  call: string;
  agentId: string;
  description: string;
  prompt: string;
  /** What it hands back when it is done, and what Claude makes of it. */
  report: string;
  reply: string;
  /** Its figures once done: tokens, tool calls, time. */
  usage: { tokens: number; toolUses: number; durationMs: number };
};

export const LICENSES: DemoAgent = {
  call: 'toolu_demo_ag_licenses',
  agentId: 'a7c41e9b2d05f8a36',
  description: 'Check the dependency licenses',
  prompt: 'List the licenses of every package acme-web installs, direct and indirect, and flag any that is not MIT, ISC, Apache-2.0 or BSD. Change no files.',
  report: [
    'Every one of the 225 packages acme-web installs has a license the release can ship with.',
    '',
    '| License | Packages |',
    '|---|---|',
    '| MIT | 186 |',
    '| ISC | 21 |',
    '| Apache-2.0 | 9 |',
    '| BSD-3-Clause | 4 |',
    '| BSD-2-Clause | 3 |',
    '| BlueOak-1.0.0 | 2 |',
    '',
    'BlueOak-1.0.0 (two small packages under vite) is a permissive license like MIT, so nothing needs to change. I changed no files.',
  ].join('\n'),
  reply: 'The licenses are fine: all 225 packages are MIT, ISC, Apache-2.0, BSD or BlueOak, which is permissive too. The check for outdated packages is still running; I’ll say what it finds.',
  usage: { tokens: 38_400, toolUses: 4, durationMs: 130_000 },
};

export const OUTDATED: DemoAgent = {
  call: 'toolu_demo_ag_outdated',
  agentId: 'a9e2b7d4c1f05a8e3',
  description: 'Find outdated dependencies',
  prompt: 'Find the dependencies of acme-web that are behind their latest version, and say for each whether upgrading would break how we use it. Read the changelogs where it matters. Change no files.',
  report: [
    'Two direct dependencies are behind, both by a minor version, and neither upgrade breaks how acme-web uses them:',
    '',
    '- **vite** 7.1.4 → 7.2.2: fixes and a faster dev server start; `vite.config` options we use are unchanged.',
    '- **@playwright/test** 1.56.0 → 1.57.0: new browsers; the login test runs as before.',
    '',
    'react and react-dom are on their latest version. I changed no files.',
  ].join('\n'),
  reply: 'The outdated check is done too: only vite and @playwright/test are behind, by a minor version each, and neither upgrade breaks anything we use. Want me to upgrade both and run the tests?',
  // Its time is how long it ran, from when it started.
  usage: { tokens: 61_900, toolUses: 6, durationMs: 0 },
};

/** What the agent still at work is doing, as its last progress report says. */
export const OUTDATED_DOING = 'Reading the login test against @playwright/test 1.57';

/** How long after the session is first opened in the web app's demo the agent at work finishes. */
export const OUTDATED_FINISHES_MS = 45_000;

/** Where Claude Code keeps what a background task writes, for the demo's agents. */
export const outputFile = (agentId: string) => `/private/tmp/claude-501/demo/${AGENTS_SESSION}/tasks/${agentId}.output`;

/** Claude Code's result for an Agent call that runs its agent in the background: words for the model alone. */
export const launchText = (agent: DemoAgent) => [
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
  `agentId: ${agent.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agent.agentId}', summary: '<5-10 word recap>' to continue this agent.)`,
  'The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.',
  'Do not duplicate this agent\'s work — avoid working with the same files or topics it is using.',
  `output_file: ${outputFile(agent.agentId)}`,
  'Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you\'ll get a completion notification.',
].join('\n');

/** What Claude Code records next to that result. */
export const launched = (agent: DemoAgent) => ({
  isAsync: true, status: 'async_launched', agentId: agent.agentId, description: agent.description, prompt: agent.prompt,
  outputFile: outputFile(agent.agentId), canReadOutputFile: true, canContinueAgent: true, resolvedModel: 'claude-opus-5-5',
});

/** The agent's report, handed back to the session as Claude Code frames it for Claude, each line indented. */
export const handbackText = (agent: DemoAgent) => [
  'Another Claude session sent a message:',
  `<agent-message from="${agent.agentId}">`,
  '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The harness indents every line of the report. The report follows:',
  ...agent.report.split('\n').map((line) => `  ${line}`),
  '</agent-message>',
].join('\n');

/** How Claude Code marks that message: from the agent, as its hand-back. */
export const handbackOrigin = (agent: DemoAgent) => ({
  kind: 'peer', from: agent.agentId, senderTaskId: agent.agentId, name: 'general-purpose', handback: true, handbackReportText: agent.report,
});

/**
 * Claude Code's notice of the agent's end, as it writes it into the conversation: `completed`, with
 * its report handed back as a message of its own, and its figures; `killed`, stopped by you.
 */
export function agentNotice(agent: DemoAgent, status: 'completed' | 'killed', usage: DemoAgent['usage'] | undefined = agent.usage): string {
  return [
    '<task-notification>',
    `<task-id>${agent.agentId}</task-id>`,
    `<tool-use-id>${agent.call}</tool-use-id>`,
    `<output-file>${outputFile(agent.agentId)}</output-file>`,
    `<status>${status}</status>`,
    `<summary>Agent "${agent.description}" ${status === 'completed' ? 'finished' : 'was stopped by user'}</summary>`,
    '<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>',
    ...(status === 'completed' ? [`<result>This agent's report was delivered to you as a message from "${agent.agentId}" (its SubagentHandback call). Read it there; it is not repeated here.\n</result>`] : []),
    ...(usage ? [`<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`] : []),
    '</task-notification>',
  ].join('\n');
}

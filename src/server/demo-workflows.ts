import type { RunState, Workflow, WorkflowAgent } from '../shared/protocol.js';
import type { DemoSession, Row } from './demo.js';


/**
 * The demo's workflows: a session in which Claude reviewed the checkout flow with a workflow that
 * finished, then started one that still runs. Its run folders are written next to its transcript as
 * Claude Code writes them (a record, a journal, each agent's transcript and meta file, the scripts),
 * all made up, with times relative to now.
 */

const MIN = 60_000;
export const WORKFLOW_SESSION = 'b5c8e1f4-cccc-4b5c-8d6e-000000000013';

const REVIEW = { call: 'toolu_demo_wf_review', task: 'w4k9qz2mx', run: 'wf_3f9c1a2b-7d4', name: 'checkout-review' } as const;
const FIXES = { call: 'toolu_demo_wf_fixes', task: 'w7p3m0rtc', run: 'wf_8e2d5b1c-a60', name: 'checkout-fixes' } as const;

const REVIEW_SCRIPT = `export const meta = {
  name: 'checkout-review',
  description: 'Review the checkout flow in two areas, then have a skeptic check each finding',
  phases: [
    { title: 'Review', detail: 'one agent per area' },
    { title: 'Verify', detail: 'a skeptic re-checks each finding' },
  ],
}

const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object' } } } }
const VERDICTS = { type: 'object', required: ['verdicts'], properties: { verdicts: { type: 'array', items: { type: 'object' } } } }

const results = await pipeline(['server', 'client'],
  (area) => agent(\`Review the \${area} side of the checkout flow and list real defects.\`, { label: \`review:\${area}\`, phase: 'Review', schema: FINDINGS }),
  (found, area) => agent(\`Re-check each finding for the \${area}: \${JSON.stringify(found)}\`, { label: \`verify:\${area}\`, phase: 'Verify', schema: VERDICTS }),
)
log(\`\${results.filter(Boolean).length} areas verified\`)
return results
`;

const FIXES_SCRIPT = `export const meta = {
  name: 'checkout-fixes',
  description: 'Fix the two confirmed findings, then run the checkout tests again',
  phases: [
    { title: 'Fix', detail: 'one agent per finding' },
    { title: 'Test', detail: 'the checkout tests, with the fixes in' },
  ],
}

const fixed = await parallel(args.findings.map((finding) =>
  agent(\`Fix this finding, with a test that fails without the fix: \${finding.title} (\${finding.file})\`, { label: \`fix:\${finding.slug}\`, phase: 'Fix' }),
))
return agent('Run the checkout tests and report what fails.', { label: 'test:checkout', phase: 'Test' })
`;

const RESULT = [
  { verdicts: [{ finding: 'The checkout accepts an empty card holder name', file: 'src/server/checkout.ts:48', verdict: 'confirmed' }] },
  { verdicts: [{ finding: 'The order summary shows the customer name unescaped', file: 'src/checkout/Summary.tsx:21', verdict: 'confirmed' }] },
];

const launchText = (flow: { task: string; run: string; name: string }, summary: string, dir: string) => {
  const script = `${dir}/workflows/scripts/${flow.name}-${flow.run}.js`;
  return [
    `Workflow launched in background. Task ID: ${flow.task}`,
    `Summary: ${summary}`,
    `Transcript dir: ${dir}/subagents/workflows/${flow.run}`,
    `Script file: ${script}`,
    `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${script}"} to iterate without resending the script.)`,
    `Run ID: ${flow.run}`,
    `To resume after editing the script: Workflow({scriptPath: "${script}", resumeFromRunId: "${flow.run}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n');
};

const launched = (flow: { task: string; run: string; name: string }, summary: string, dir: string) => ({
  status: 'async_launched', taskId: flow.task, taskType: 'local_workflow', workflowName: flow.name, runId: flow.run, summary,
  transcriptDir: `${dir}/subagents/workflows/${flow.run}`, scriptPath: `${dir}/workflows/scripts/${flow.name}-${flow.run}.js`,
});

const REVIEW_SUMMARY = 'Review the checkout flow in two areas, then have a skeptic check each finding';
const FIXES_SUMMARY = 'Fix the two confirmed findings, then run the checkout tests again';

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (value: string) => ({ type: 'text', text: value });

/** How many tool calls an agent made: as many as its transcript holds, so its figures and its steps agree. */
function toolCalls(agentId: string): number {
  const own = steps('')[agentId]?.steps ?? [];
  return own.filter((s) => s.role === 'assistant').flatMap((s) => s.content).filter((b) => (b as { type?: unknown }).type === 'tool_use').length;
}

/** The finished review: when it started and ended, and its agents as Claude Code's record keeps them. */
function reviewAgents(start: number): WorkflowAgent[] {
  const agent = (index: number, label: string, phase: 1 | 2, agentId: string, at: number, ms: number, tokens: number, result: unknown, prompt: string, lastToolName: string): WorkflowAgent => ({
    index, label, phaseIndex: phase, phaseTitle: phase === 1 ? 'Review' : 'Verify', agentId, model: 'claude-opus-5-5', state: 'done',
    queuedAt: start + at, startedAt: start + at, lastProgressAt: start + at + ms, durationMs: ms, tokens, toolCalls: toolCalls(agentId), attempt: 1, lastToolName,
    resultPreview: JSON.stringify(result), promptPreview: prompt,
  });
  return [
    agent(1, 'review:server', 1, 'a1c3e5a7b9d1f3a52', 20, 181_000, 120_800, { findings: [{ title: 'The checkout accepts an empty card holder name', file: 'src/server/checkout.ts:48' }] }, 'Review the server side of the checkout flow and list real defects.', 'StructuredOutput'),
    agent(2, 'review:client', 1, 'a2d4f6b8c0e2a4b63', 22, 95_300, 88_200, { findings: [{ title: 'The order summary shows the customer name unescaped', file: 'src/checkout/Summary.tsx:21' }] }, 'Review the client side of the checkout flow and list real defects.', 'StructuredOutput'),
    agent(3, 'verify:server', 2, 'a3e5a7c9d1f3b5c74', 181_100, 180_000, 131_900, RESULT[0], 'Re-check each finding for the server: [The checkout accepts an empty card holder name]', 'StructuredOutput'),
    agent(4, 'verify:client', 2, 'a4f6b8d0e2a4c6d85', 95_400, 52_000, 71_400, RESULT[1], 'Re-check each finding for the client: [The order summary shows the customer name unescaped]', 'StructuredOutput'),
  ];
}

/** The review's totals, as Claude Code sums its agents'. */
const reviewTotals = () => {
  const agents = reviewAgents(0);
  return { tokens: agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0), toolCalls: agents.reduce((sum, a) => sum + (a.toolCalls ?? 0), 0) };
};

/** The fixes, still at work: one agent done, one running (its edit under way), the tests up next. */
function fixAgents(start: number, now: number): WorkflowAgent[] {
  return [
    {
      index: 1, label: 'fix:empty-name', phaseIndex: 1, phaseTitle: 'Fix', agentId: 'b1a3c5e7d9f1a3b52', model: 'claude-opus-5-5', state: 'done',
      queuedAt: start + 30, startedAt: start + 30, lastProgressAt: start + 61_000, durationMs: 61_000, tokens: 54_300, toolCalls: toolCalls('b1a3c5e7d9f1a3b52'), attempt: 1,
      lastToolName: 'Bash', resultPreview: 'The checkout now refuses an empty card holder name, with a test that fails without the fix.',
      promptPreview: 'Fix this finding, with a test that fails without the fix: The checkout accepts an empty card holder name (src/server/checkout.ts:48)',
    },
    {
      index: 2, label: 'fix:unescaped-name', phaseIndex: 1, phaseTitle: 'Fix', agentId: 'b2b4d6f8e0a2b4c63', model: 'claude-opus-5-5', state: 'progress',
      queuedAt: start + 32, startedAt: start + 32, lastProgressAt: now - 6_000, tokens: 48_200, toolCalls: toolCalls('b2b4d6f8e0a2b4c63'), attempt: 1,
      lastToolName: 'Edit', lastToolSummary: 'src/checkout/Summary.tsx',
      promptPreview: 'Fix this finding, with a test that fails without the fix: The order summary shows the customer name unescaped (src/checkout/Summary.tsx:21)',
    },
  ];
}

/**
 * The fixes as this Pelican's Claude would report them while they run: as the runner sends them,
 * without the agents' prompts and results, which an agent opened reads from its own files.
 */
export function demoFixes(now = Date.now()): Workflow {
  const start = now - 2 * MIN - 41_000;
  const agents = fixAgents(start, now).map(({ promptPreview: _prompt, resultPreview: _result, ...agent }) => agent);
  return {
    runId: FIXES.run, taskId: FIXES.task, name: FIXES.name, description: FIXES_SUMMARY, status: 'running', startedAt: start,
    totalTokens: agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0), totalToolCalls: agents.reduce((sum, a) => sum + (a.toolCalls ?? 0), 0),
    phases: [{ title: 'Fix', detail: 'one agent per finding' }, { title: 'Test', detail: 'the checkout tests, with the fixes in' }],
    agents, source: 'live',
  };
}

/** The session's run: Claude is done with its turn, and the fixes run on in the background. */
export function demoWorkflowRun(sessionId: string, cwd: string): RunState | undefined {
  if (sessionId !== WORKFLOW_SESSION) return undefined;
  const fixes = demoFixes();
  return {
    sessionId,
    cwd,
    busy: false,
    settings: { model: 'default', effort: 'high', permissionMode: 'acceptEdits' },
    partial: [],
    permissions: [],
    tasks: [{ id: FIXES.task, description: FIXES.name, type: 'local_workflow', summary: `${fixes.agents.filter((a) => a.state === 'done').length}/${fixes.agents.length} agents` }],
    workflows: { [FIXES.call]: fixes },
    lastTurn: { durationMs: 9_000, outputTokens: 610 },
    context: { percent: 18, tokens: 36_000, max: 200_000 },
  };
}

/** An agent's own transcript, as Claude Code writes one: a side chain, its prompt framed. */
function agentTranscript(agentId: string, cwd: string, sessionId: string, prompt: string, steps: Array<{ at: number; content: unknown[]; role: 'user' | 'assistant' }>, start: number): string {
  let parent: string | null = null;
  const lines: string[] = [];
  const row = (uuid: string, type: 'user' | 'assistant', message: Record<string, unknown>, at: number) => {
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: true, agentId, type, message, uuid, timestamp: new Date(at).toISOString(), userType: 'external', cwd, sessionId, version: '2.1.318' }));
    parent = uuid;
  };
  const framed = `[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n${prompt.split('\n').map((line) => `  ${line}`).join('\n')}`;
  row(`${agentId}-0`, 'user', { role: 'user', content: framed }, start);
  steps.forEach((step, i) => {
    row(`${agentId}-${i + 1}`, step.role, step.role === 'assistant'
      ? { id: `msg_demo_${agentId}_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: step.content }
      : { role: 'user', content: step.content }, start + step.at);
  });
  return `${lines.join('\n')}\n`;
}

const result = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });

/** The steps each agent took, a few tool calls and what it returned. */
function steps(cwd: string): Record<string, { prompt: string; steps: Array<{ at: number; role: 'user' | 'assistant'; content: unknown[] }> }> {
  const read = (id: string, file: string) => tool(id, 'Read', { file_path: `${cwd}/${file}` });
  const done = (id: string, value: unknown) => tool(id, 'StructuredOutput', value as Record<string, unknown>);
  return {
    a1c3e5a7b9d1f3a52: {
      prompt: 'Review the server side of the checkout flow and list real defects.',
      steps: [
        { at: 4_000, role: 'assistant', content: [tool('s1', 'Grep', { pattern: 'cardHolder', path: `${cwd}/src/server` })] },
        { at: 5_000, role: 'user', content: [result('s1', 'src/server/checkout.ts:48:  const cardHolder = body.cardHolder ?? \'\'')] },
        { at: 9_000, role: 'assistant', content: [read('s2', 'src/server/checkout.ts')] },
        { at: 10_000, role: 'user', content: [result('s2', '    46\texport async function placeOrder(body: OrderBody) {\n    47\t  const items = await cart.items(body.cartId)\n    48\t  const cardHolder = body.cardHolder ?? \'\'\n    49\t  return payments.charge({ items, cardHolder })\n    50\t}')] },
        { at: 30_000, role: 'assistant', content: [tool('s3', 'Bash', { command: 'npm test -- checkout', description: 'Run the checkout tests' })] },
        { at: 70_000, role: 'user', content: [result('s3', ' PASS  test/checkout.test.ts (14 tests)\n\nTests: 14 passed, 14 total')] },
        { at: 180_000, role: 'assistant', content: [done('s4', { findings: [{ title: 'The checkout accepts an empty card holder name', file: 'src/server/checkout.ts:48' }] })] },
        { at: 181_000, role: 'user', content: [result('s4', 'Structured output provided successfully')] },
      ],
    },
    a2d4f6b8c0e2a4b63: {
      prompt: 'Review the client side of the checkout flow and list real defects.',
      steps: [
        { at: 3_000, role: 'assistant', content: [read('c1', 'src/checkout/Summary.tsx')] },
        { at: 4_000, role: 'user', content: [result('c1', '    20\t<h2>Order for</h2>\n    21\t<div dangerouslySetInnerHTML={{ __html: order.customerName }} />')] },
        { at: 40_000, role: 'assistant', content: [tool('c2', 'Grep', { pattern: 'dangerouslySetInnerHTML', path: `${cwd}/src` })] },
        { at: 41_000, role: 'user', content: [result('c2', 'src/checkout/Summary.tsx:21')] },
        { at: 95_000, role: 'assistant', content: [done('c3', { findings: [{ title: 'The order summary shows the customer name unescaped', file: 'src/checkout/Summary.tsx:21' }] })] },
        { at: 95_300, role: 'user', content: [result('c3', 'Structured output provided successfully')] },
      ],
    },
    a3e5a7c9d1f3b5c74: {
      prompt: 'Re-check each finding for the server: [The checkout accepts an empty card holder name]',
      steps: [
        { at: 5_000, role: 'assistant', content: [read('v1', 'src/server/checkout.ts')] },
        { at: 6_000, role: 'user', content: [result('v1', '    48\t  const cardHolder = body.cardHolder ?? \'\'')] },
        { at: 60_000, role: 'assistant', content: [tool('v2', 'Bash', { command: 'curl -s -X POST localhost:3000/api/orders -d \'{"cartId":"c1","cardHolder":""}\'', description: 'Place an order with an empty name' })] },
        { at: 62_000, role: 'user', content: [result('v2', '{"ok":true,"order":"o_1042"}')] },
        { at: 179_000, role: 'assistant', content: [done('v3', RESULT[0])] },
        { at: 180_000, role: 'user', content: [result('v3', 'Structured output provided successfully')] },
      ],
    },
    a4f6b8d0e2a4c6d85: {
      prompt: 'Re-check each finding for the client: [The order summary shows the customer name unescaped]',
      steps: [
        { at: 20_000, role: 'assistant', content: [read('w1', 'src/checkout/Summary.tsx')] },
        { at: 21_000, role: 'user', content: [result('w1', '    21\t<div dangerouslySetInnerHTML={{ __html: order.customerName }} />')] },
        { at: 51_000, role: 'assistant', content: [done('w2', RESULT[1])] },
        { at: 52_000, role: 'user', content: [result('w2', 'Structured output provided successfully')] },
      ],
    },
    b1a3c5e7d9f1a3b52: {
      prompt: 'Fix this finding, with a test that fails without the fix: The checkout accepts an empty card holder name (src/server/checkout.ts:48)',
      steps: [
        { at: 3_000, role: 'assistant', content: [read('f1', 'src/server/checkout.ts')] },
        { at: 4_000, role: 'user', content: [result('f1', '    48\t  const cardHolder = body.cardHolder ?? \'\'')] },
        { at: 20_000, role: 'assistant', content: [tool('f2', 'Edit', { file_path: `${cwd}/src/server/checkout.ts`, old_string: "  const cardHolder = body.cardHolder ?? ''", new_string: "  const cardHolder = body.cardHolder?.trim()\n  if (!cardHolder) throw new OrderError('The card holder name is missing')" })] },
        { at: 21_000, role: 'user', content: [result('f2', `The file ${cwd}/src/server/checkout.ts has been updated successfully.`)] },
        { at: 45_000, role: 'assistant', content: [tool('f3', 'Bash', { command: 'npm test -- checkout', description: 'Run the checkout tests' })] },
        { at: 59_000, role: 'user', content: [result('f3', ' PASS  test/checkout.test.ts (15 tests)\n\nTests: 15 passed, 15 total')] },
        { at: 61_000, role: 'assistant', content: [text('The checkout now refuses an empty card holder name, with a test that fails without the fix.')] },
      ],
    },
    b2b4d6f8e0a2b4c63: {
      prompt: 'Fix this finding, with a test that fails without the fix: The order summary shows the customer name unescaped (src/checkout/Summary.tsx:21)',
      steps: [
        { at: 4_000, role: 'assistant', content: [read('g1', 'src/checkout/Summary.tsx')] },
        { at: 5_000, role: 'user', content: [result('g1', '    21\t<div dangerouslySetInnerHTML={{ __html: order.customerName }} />')] },
        { at: 50_000, role: 'assistant', content: [tool('g2', 'Grep', { pattern: 'customerName', path: `${cwd}/src` })] },
        { at: 51_000, role: 'user', content: [result('g2', 'src/checkout/Summary.tsx:21\nsrc/checkout/Receipt.tsx:9')] },
        // At work on it now: the edit its row names, not answered yet.
        { at: 95_000, role: 'assistant', content: [tool('g3', 'Edit', { file_path: `${cwd}/src/checkout/Summary.tsx`, old_string: '      <div dangerouslySetInnerHTML={{ __html: order.customerName }} />', new_string: '      <div>{order.customerName}</div>' })] },
      ],
    },
  };
}

const meta = (label: string, phase: string) => JSON.stringify({ agentType: 'workflow-subagent', isBuiltIn: true, description: label, workflowPhase: phase, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true, pickedEffortModel: 'claude-opus-5-5' });

const key = (n: number) => `v2:${n.toString(16).padStart(64, '0')}`;

/** The session's own folder, as Claude Code leaves it: the record, the journals, the agents, the scripts. */
function files(cwd: string, dir: string, sessionId: string, reviewStart: number, fixesStart: number): Record<string, string> {
  const review = reviewAgents(reviewStart);
  const fixes = fixAgents(fixesStart, Date.now());
  const all = steps(cwd);
  const out: Record<string, string> = {
    [`workflows/scripts/${REVIEW.name}-${REVIEW.run}.js`]: REVIEW_SCRIPT,
    [`workflows/scripts/${FIXES.name}-${FIXES.run}.js`]: FIXES_SCRIPT,
    [`workflows/${REVIEW.run}.json`]: JSON.stringify({
      runId: REVIEW.run, timestamp: new Date(reviewStart + 361_250).toISOString(), taskId: REVIEW.task, script: REVIEW_SCRIPT,
      scriptPath: `${dir}/workflows/scripts/${REVIEW.name}-${REVIEW.run}.js`, result: RESULT, agentCount: 4, logs: ['2 areas verified'],
      durationMs: 361_250, summary: REVIEW_SUMMARY, workflowName: REVIEW.name, status: 'completed', startTime: reviewStart,
      phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify', detail: 'a skeptic re-checks each finding' }], defaultModel: 'claude-opus-5-5',
      workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Review' }, { type: 'workflow_phase', index: 2, title: 'Verify' }, ...review.map((a) => ({ type: 'workflow_agent', ...a }))],
      totalTokens: reviewTotals().tokens, totalToolCalls: reviewTotals().toolCalls,
    }),
  };
  const journal = (run: string, agents: WorkflowAgent[]) => [
    JSON.stringify({ type: 'launched' }),
    ...agents.flatMap((a, i) => [
      JSON.stringify({ type: 'started', key: key(i + 1), agentId: a.agentId, label: a.label, phase: a.phaseTitle }),
      ...(a.state === 'done' ? [JSON.stringify({ type: 'result', key: key(i + 1), agentId: a.agentId, result: JSON.parse(a.resultPreview!.startsWith('{') ? a.resultPreview! : JSON.stringify(a.resultPreview)), remoteControlDeviceReport: false, toolsUsed: ['Read', 'StructuredOutput'] })] : []),
    ]),
  ].join('\n');
  out[`subagents/workflows/${REVIEW.run}/journal.jsonl`] = `${journal(REVIEW.run, review)}\n`;
  out[`subagents/workflows/${FIXES.run}/journal.jsonl`] = `${journal(FIXES.run, fixes)}\n`;
  for (const [run, agents] of [[REVIEW.run, review], [FIXES.run, fixes]] as const) {
    for (const agent of agents) {
      const own = all[agent.agentId!]!;
      out[`subagents/workflows/${run}/agent-${agent.agentId}.meta.json`] = meta(agent.label, agent.phaseTitle!);
      out[`subagents/workflows/${run}/agent-${agent.agentId}.jsonl`] = agentTranscript(agent.agentId!, cwd, sessionId, own.prompt, own.steps, agent.startedAt!);
    }
  }
  return out;
}

const notice = () => [
  '<task-notification>',
  `<task-id>${REVIEW.task}</task-id>`,
  `<tool-use-id>${REVIEW.call}</tool-use-id>`,
  `<output-file>/tmp/claude-501/demo/${WORKFLOW_SESSION}/tasks/${REVIEW.task}.output</output-file>`,
  '<status>completed</status>',
  `<summary>Dynamic workflow "${REVIEW_SUMMARY}" completed</summary>`,
  `<result>${JSON.stringify(RESULT)}</result>`,
  '<usage><agent_count>4</agent_count><agents_done>4</agents_done><agents_error>0</agents_error><agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result>'
  + `<subagent_tokens>${reviewTotals().tokens}</subagent_tokens><tool_uses>${reviewTotals().toolCalls}</tool_uses><duration_ms>${361_250}</duration_ms></usage>`,
  '</task-notification>',
].join('\n');

/** The session itself: the request, the review, what held up, and the fixes it started. */
export const WORKFLOW_DEMO: DemoSession = {
  id: WORKFLOW_SESSION,
  title: 'Review the checkout flow before the release',
  project: 'acme-web',
  branch: 'fix/checkout',
  rows: (cwd, dir = cwd) => {
    const { reviewStart, fixesStart } = times();
    const t = reviewStart - 6_000;
    const rows: Row[] = [
      { role: 'user', at: t, content: 'Review the checkout flow before the release: the server and the client, with a second look at each finding. Then fix what holds up.' },
      {
        role: 'assistant',
        at: t + 5_000,
        content: [text('I\'ll run it as a workflow: one reviewer per area, then a skeptic re-checks what each one found.'), tool(REVIEW.call, 'Workflow', { script: REVIEW_SCRIPT })],
      },
      { role: 'user', at: reviewStart, content: [result(REVIEW.call, launchText(REVIEW, REVIEW_SUMMARY, dir))], result: launched(REVIEW, REVIEW_SUMMARY, dir) },
      { role: 'assistant', at: reviewStart + 3_000, content: [text('The review is running in the background. I\'ll read the findings when it is done.')] },
      { role: 'user', at: reviewStart + 361_300, content: notice() },
      {
        role: 'assistant',
        at: reviewStart + 380_000,
        content: [
          text('Both findings held up:\n\n- **The checkout accepts an empty card holder name** (`src/server/checkout.ts:48`): the order goes through and the payment fails later.\n- **The order summary shows the customer name unescaped** (`src/checkout/Summary.tsx:21`): a name with markup in it runs in the page.\n\nI\'ll fix both, each with a test, then run the checkout tests again.'),
          tool(FIXES.call, 'Workflow', { script: FIXES_SCRIPT, args: { findings: [{ slug: 'empty-name', title: RESULT[0]!.verdicts[0]!.finding, file: 'src/server/checkout.ts:48' }, { slug: 'unescaped-name', title: RESULT[1]!.verdicts[0]!.finding, file: 'src/checkout/Summary.tsx:21' }] } }),
        ],
      },
      { role: 'user', at: fixesStart, content: [result(FIXES.call, launchText(FIXES, FIXES_SUMMARY, dir))], result: launched(FIXES, FIXES_SUMMARY, dir) },
      { role: 'assistant', at: fixesStart + 4_000, content: [text('The fixes are running in the background, one agent per finding, then the tests. I\'ll say what the tests find.')] },
    ];
    return rows;
  },
  files: (cwd, dir) => {
    const { reviewStart, fixesStart } = times();
    return files(cwd, dir, WORKFLOW_SESSION, reviewStart, fixesStart);
  },
};

/** When the review ran and the fixes started: written once, when the demo starts. */
let started: { reviewStart: number; fixesStart: number } | undefined;
function times() {
  if (!started) {
    const fixesStart = Date.now() - 2 * MIN - 41_000;
    started = { reviewStart: fixesStart - 361_250 - 50_000, fixesStart };
  }
  return started;
}

export const DEMO_WORKFLOW_FILES = {
  'src/server/checkout.ts': "import { cart } from './cart';\nimport { payments } from './payments';\n\nexport async function placeOrder(body: OrderBody) {\n  const items = await cart.items(body.cartId)\n  const cardHolder = body.cardHolder ?? ''\n  return payments.charge({ items, cardHolder })\n}\n",
  'src/checkout/Summary.tsx': "export function Summary({ order }: { order: Order }) {\n  return (\n    <section>\n      <h2>Order for</h2>\n      <div dangerouslySetInnerHTML={{ __html: order.customerName }} />\n    </section>\n  );\n}\n",
};

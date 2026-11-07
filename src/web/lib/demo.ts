import { useSyncExternalStore } from 'react';

import { isSavedEffort, modelKey, type StartDefaults } from '../../shared/defaults';
import { isPermissionMode } from '../../shared/modes';
import type {
  Block, ChatMessage, MessagesPage, ModelOption, PermissionDecision, PermissionRequest, PrStatus, Rewound, RewindCheck, RewindDone, RunSettings, RunState, SendMode, ServerInfo,
  SessionChanges, SessionStatus, SessionSummary, Workflow,
} from '../../shared/protocol';
import { COMMIT_REQUEST, requestShown } from '../../shared/requests';
import { AGENTS_SESSION, agentNotice, type DemoAgent, handbackText, LICENSES, OUTDATED, OUTDATED_FINISHES_MS } from '../../shared/demo-agents';
import { FIRST_MESSAGE, NOT_HERE, NOTHING_TO_UNDO, REWIND_BUSY } from '../../shared/rewind';
import { currentTasks, type Todo } from '../../shared/tasks';
import { isLive } from '../../shared/workflows';
import { promptGist } from '../../shared/quoted';
import { shortTitle } from '../../shared/titles';
import { answerLocally, api, ApiError } from './api';
import { fromDefaults } from './defaults';
import { newId } from './ids';
import { DEMO_NOTE, DemoRefusal, INSTALL_URL, STATIC_DEMO } from './static-demo';
import { addLocalMessage, getView, setRewound, setRun } from './store';
import { splitFiles } from './turns';

/**
 * The demo acts out the moments it exists to show, and says calmly what it cannot do. Allow on the
 * waiting edit plays out the rest of that step: the edit lands, the next task starts and Claude
 * says what it did. A message gets a reply that says what Claude would do with it. Rewind to here
 * takes the conversation back (with Undo rewind) and Fork copies it, in the page. Anything else
 * that would change something gets the one demo note. Both demos run this: the site's, which has no
 * server, and `pelican --demo`, whose server runs nothing; nothing here leaves the page.
 */

type Story = {
  /** The run as the demo has it now, over the server's. */
  run?: RunState;
  /** What the demo added to the conversation, oldest first. */
  added: ChatMessage[];
  timers: ReturnType<typeof setTimeout>[];
  /** A session the demo started itself. */
  summary?: SessionSummary;
  /** Of a copy the demo made (Fork): the session it copied. */
  copyOf?: string;
  /**
   * Where the demo rewound the conversation (Rewind to here): its prompt, when, how many of `added`
   * came before it, and whether a message has gone since (then Undo rewind is over).
   */
  cut?: { prompt: string; at: number; added: number; spent?: boolean };
};

const stories = new Map<string, Story>();
const folders = new Map<string, string>();
const titles = new Map<string, string>();
/** The side chats the demo's server lists: a question asked in one gets a side chat's answer, as one made here does. */
const sideChats = new Set<string>();
let home = '';

const storyOf = (id: string): Story => {
  let story = stories.get(id);
  if (!story) {
    story = { added: [], timers: [] };
    stories.set(id, story);
  }
  return story;
};

// A note for one chat, said under its conversation (a steer the demo cannot act on).
const notes = new Map<string, string>();
const noteListeners = new Set<() => void>();
function setNote(sessionId: string, note: string | undefined): void {
  if (note) notes.set(sessionId, note);
  else notes.delete(sessionId);
  for (const listener of noteListeners) listener();
}
export function useDemoNote(sessionId: string | undefined): [string | undefined, () => void] {
  const note = useSyncExternalStore(
    (listener) => {
      noteListeners.add(listener);
      return () => noteListeners.delete(listener);
    },
    () => (sessionId ? notes.get(sessionId) : undefined),
  );
  return [note, () => sessionId && setNote(sessionId, undefined)];
}

/** The reply to a message: what your own Pelican would do with it. */
export const DEMO_REPLY = STATIC_DEMO
  ? `This demo has no Claude behind it. In your own Pelican, Claude Code answers here, in the same session as on your computer. [Install Pelican](${INSTALL_URL})`
  : 'This is the demo, so no Claude answers. Start Pelican without `--demo` and Claude Code answers here, in the same session as on your computer.';

export const DEMO_STEER = 'In your own Pelican, Claude would read this at its next step.';

/** A side question's reply: what Claude would do with it in your own Pelican. */
export const DEMO_SIDE_REPLY = STATIC_DEMO
  ? `This demo has no Claude behind it. In your own Pelican, Claude answers here from the session so far, reading files but changing nothing. [Install Pelican](${INSTALL_URL})`
  : 'This is the demo, so no Claude answers. Start Pelican without `--demo` and Claude answers here from the session so far, reading files but changing nothing.';

/** What Claude says after the step that was waiting for you, by request id (the server's demoRunState). */
const AFTER: Record<string, string> = {
  'demo-permission': 'The toggle is in place, next to the font size picker. Next I’d remember the choice, so the theme stays after a reload. The demo stops here.',
};

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const lines = (text: string) => (text ? text.split('\n').length : 0);

/** The lines an edit changed: what its old and new text share at either end did not change. */
function changedLines(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return { added: b.length - start - end, removed: a.length - start - end };
}

const assistant = (blocks: Block[]): ChatMessage => ({
  uuid: newId(), role: 'assistant', blocks, timestamp: Date.now(), messageId: `msg_demo_${newId().slice(0, 12)}`, model: 'claude-opus-5-5',
});
const user = (blocks: Block[], extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid: newId(), role: 'user', blocks, timestamp: Date.now(), ...extra });

function say(sessionId: string, message: ChatMessage): void {
  storyOf(sessionId).added.push(message);
  addLocalMessage(sessionId, message);
}

function runAs(sessionId: string, run: RunState): void {
  storyOf(sessionId).run = run;
  setRun(sessionId, run);
}

function later(sessionId: string, ms: number, step: () => void): void {
  storyOf(sessionId).timers.push(setTimeout(step, ms));
}

const currentRun = (sessionId: string): RunState | undefined => getView(sessionId).run ?? stories.get(sessionId)?.run;

const idleRun = (sessionId: string, settings: RunSettings = {}): RunState => ({
  sessionId, cwd: folders.get(sessionId) ?? '', busy: false, settings, permissions: [], partial: [],
});

/** The task list with the task under way done and the next one started; undefined when there is none. */
export function advance(tasks: Todo[]): Todo[] | undefined {
  const at = tasks.findIndex((t) => t.status === 'in_progress');
  if (at < 0) return undefined;
  const next = tasks.findIndex((t, i) => i > at && t.status === 'pending');
  return tasks.map((t, i) => (i === at ? { ...t, status: 'completed' } : i === next ? { ...t, status: 'in_progress' } : t));
}

/** The turn ends, with what it took. */
function finish(sessionId: string, durationMs: number): void {
  const run = currentRun(sessionId) ?? idleRun(sessionId);
  end(sessionId, { ...run, lastTurn: { durationMs, outputTokens: 180 + Math.round(durationMs / 20) } });
}

/**
 * Claude is done with the turn, stopped or not: idle, unless messages were queued meanwhile. Those
 * go next, at once and in one message, as your own Pelican sends them (also after Stop).
 */
function end(sessionId: string, run: RunState): void {
  const { queued = [], ...rest } = run;
  runAs(sessionId, { ...rest, busy: false, permissions: [], partial: [] });
  if (queued.length === 0) return;
  const text = queued.map((p) => p.text).filter(Boolean).join('\n\n');
  reply(sessionId, user(text ? [{ type: 'text', text }] : [], { uuid: queued[0]!.uuid }));
}

/** A message taken by Claude, answered with what Claude would do (a side chat's: what it would do there). */
function reply(sessionId: string, message: ChatMessage): void {
  say(sessionId, message);
  const run = currentRun(sessionId) ?? idleRun(sessionId);
  runAs(sessionId, { ...run, busy: true, permissions: [], partial: [] });
  const typedText = message.blocks.find((b) => b.type === 'text');
  if (typedText?.type === 'text' && actRequest(sessionId, typedText.text)) return;
  const words = sideChats.has(sessionId) || stories.get(sessionId)?.summary?.sideChatOf ? DEMO_SIDE_REPLY : DEMO_REPLY;
  later(sessionId, 1400, () => {
    say(sessionId, assistant([{ type: 'text', text: words }]));
    finish(sessionId, 1400);
  });
}

/** The pull requests the demo made in the page, by address, for their cards. */
const demoPulls = new Map<string, PrStatus>();

/** A command Claude runs in the demo's story, and what it printed: a step, as a turn shows one. */
function ranCommand(sessionId: string, at: number, command: string, description: string, output: string): void {
  later(sessionId, at, () => {
    const id = `toolu_demo_${newId().slice(0, 12)}`;
    say(sessionId, assistant([{ type: 'tool_use', id, name: 'Bash', input: { command, description } }]));
    say(sessionId, user([{ type: 'tool_result', tool_use_id: id, content: output }]));
  });
}

/**
 * Commit changes and Create PR, sent from Changes, acted out as Claude would carry them out: the
 * commit, or the push and the pull request, which the reply names in Desktop's tag, for its card.
 * Nothing runs: the steps and the pull request are made up. Whether the text was one of them.
 */
function actRequest(sessionId: string, text: string): boolean {
  const shown = requestShown(text);
  if (text !== COMMIT_REQUEST && !shown) return false;
  if (!shown) {
    ranCommand(sessionId, 700, 'git add -A && git commit -m "Add a dark theme toggle to Settings"', 'Commit the changes', '[feat/dark-theme a1b2c3d] Add a dark theme toggle to Settings\n 3 files changed, 31 insertions(+), 2 deletions(-)');
    later(sessionId, 1500, () => {
      say(sessionId, assistant([{ type: 'text', text: 'Committed as `a1b2c3d`: \u201cAdd a dark theme toggle to Settings\u201d.' }]));
      finish(sessionId, 1500);
    });
    return true;
  }
  const branch = /^Branch: (.+)$/m.exec(text)?.[1] ?? 'feat/dark-theme';
  const base = /^Base branch: (.+)$/m.exec(text)?.[1] ?? 'main';
  const repo = /^Repository: (.+)$/m.exec(text)?.[1] ?? 'acme/acme-web';
  const title = stories.get(sessionId)?.summary?.title ?? titles.get(sessionId) ?? 'Changes from the demo';
  const url = `https://github.com/${repo}/pull/${129 + demoPulls.size}`;
  const draft = shown.endsWith('--draft');
  demoPulls.set(url, { live: true, number: 129 + demoPulls.size, title, state: 'open', draft, head: branch, base, checks: 'running' });
  ranCommand(sessionId, 700, `git push -u origin ${branch}`, 'Push the branch', `branch '${branch}' set up to track 'origin/${branch}'.`);
  ranCommand(sessionId, 1400, `gh pr create${draft ? ' --draft' : ''} --base ${base} --title "${title}" --body-file -`, 'Open the pull request', url);
  later(sessionId, 2100, () => {
    say(sessionId, assistant([{ type: 'text', text: `The pull request is open${draft ? ', as a draft' : ''}.\n<pr-created>${url}</pr-created>` }]));
    finish(sessionId, 2100);
  });
  return true;
}

function resultOf(request: PermissionRequest, decision: PermissionDecision): { content: string; is_error?: boolean } {
  if (decision.behavior === 'deny') {
    return { content: `The user doesn't want to proceed with this tool use. The tool use was rejected.${decision.message ? ` The user said: ${decision.message}` : ''}`, is_error: true };
  }
  if (request.toolName === 'ExitPlanMode') return { content: 'User has approved your plan. You can now start coding.' };
  if (request.toolName === 'AskUserQuestion') return { content: 'The user answered your questions.' };
  if (FILE_TOOLS.has(request.toolName)) return { content: `The file ${str(request.input.file_path)} has been updated successfully.` };
  return { content: 'Done.' };
}

/** Allow or Deny on what Claude asked for: the step plays out, then the turn ends with a reply. */
function decide(sessionId: string, requestId: string, decision: PermissionDecision): { ok: boolean } {
  const run = currentRun(sessionId);
  const request = run?.permissions.find((p) => p.id === requestId);
  if (!run || !request) return { ok: true };
  runAs(sessionId, { ...run, permissions: run.permissions.filter((p) => p !== request), busy: true });
  const call = {
    type: 'tool_use' as const,
    id: `toolu_demo_${newId().slice(0, 12)}`,
    name: request.toolName,
    input: decision.behavior === 'allow' && decision.updatedInput ? decision.updatedInput : request.input,
  };
  const allowed = decision.behavior === 'allow';
  later(sessionId, 500, () => {
    say(sessionId, assistant([call]));
    say(sessionId, user([{ type: 'tool_result', tool_use_id: call.id, ...resultOf(request, decision) }]));
  });
  const tasks = allowed ? advance(currentTasks(getView(sessionId).messages)) : undefined;
  if (tasks) {
    later(sessionId, 1200, () => {
      const id = `toolu_demo_${newId().slice(0, 12)}`;
      say(sessionId, assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: tasks } }]));
      say(sessionId, user([{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }]));
    });
  }
  const words = !allowed
    ? (decision.message ? 'Understood. I’ll leave it as it was and take your note into account.' : 'Understood, I won’t make that change. What should I do instead?')
    : AFTER[request.id] ?? 'Done. In your own Pelican, Claude would carry on from here.';
  later(sessionId, tasks ? 2000 : 1300, () => {
    say(sessionId, assistant([{ type: 'text', text: words }]));
    finish(sessionId, tasks ? 2000 : 1300);
  });
  return { ok: true };
}

type SendBody = { text: string; uuid: string; settings?: RunSettings; mode?: SendMode; cwd?: string; scratch?: boolean };

function send(sessionId: string, body: SendBody): { sessionId: string } {
  const message = user(body.text ? [{ type: 'text', text: body.text }] : [], { uuid: body.uuid });
  const run = currentRun(sessionId);
  // Rewound: the message goes after the cut, and Undo rewind is over.
  const cut = stories.get(sessionId)?.cut;
  if (cut && !cut.spent) {
    cut.spent = true;
    later(sessionId, 0, () => setRewound(sessionId, undefined));
  }
  if (run?.busy) {
    if (body.mode === 'queue') {
      // Above the composer until the turn ends, as your own Pelican shows it: not in the conversation yet.
      runAs(sessionId, { ...run, queued: [...(run.queued ?? []), { uuid: body.uuid, text: body.text }] });
    } else {
      say(sessionId, { ...message, steered: true });
      later(sessionId, 600, () => setNote(sessionId, DEMO_STEER));
    }
    return { sessionId };
  }
  // A side chat runs in its own mode, whatever the session's.
  if (!run) runAs(sessionId, idleRun(sessionId, sideChats.has(sessionId) ? { ...body.settings, permissionMode: 'dontAsk' } : body.settings));
  reply(sessionId, message);
  return { sessionId };
}

/** A new session, started in the page: the list and the chat show it like any other. */
function create(body: SendBody): { sessionId: string } {
  const id = newId();
  const cwd = body.cwd ?? `${home}/scratch/demo`;
  folders.set(id, cwd);
  const story = storyOf(id);
  story.summary = {
    id,
    title: shortTitle(body.text) || 'New session',
    cwd,
    project: cwd.split('/').filter(Boolean).at(-1) ?? '',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    status: 'running',
    ...(body.scratch ? { scratch: true } : {}),
  };
  // What was picked for it, the rest as the demo's Claude Code settings start a session.
  runAs(id, idleRun(id, startDefaults ? { ...fromDefaults(startDefaults, demoModels), ...body.settings } : body.settings));
  reply(id, user(body.text ? [{ type: 'text', text: body.text }] : [], { uuid: body.uuid }));
  return { sessionId: id };
}

/**
 * A side question: a side chat of the session's, started in the page like a new session, listed
 * under it, and called by its question, as the server calls one (side-chat.ts).
 */
function side(sessionId: string, body: { question?: string; uuid?: string; settings?: RunSettings }): { sessionId: string } {
  const id = newId();
  const cwd = folders.get(sessionId) ?? '';
  folders.set(id, cwd);
  const question = shortTitle(promptGist(body.question ?? ''));
  storyOf(id).summary = {
    id,
    title: question || 'Side chat',
    cwd,
    project: cwd.split('/').filter(Boolean).at(-1) ?? '',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    status: 'running',
    sideChatOf: sessionId,
    ...(question ? { sideQuestion: question } : {}),
    ...(question && body.uuid ? { sideStart: body.uuid } : {}),
  };
  runAs(id, idleRun(id, { ...body.settings, permissionMode: 'dontAsk' }));
  reply(id, user([{ type: 'text', text: body.question ?? '' }], body.uuid ? { uuid: body.uuid } : {}));
  return { sessionId: id };
}

function interrupt(sessionId: string): { ok: boolean } {
  const story = storyOf(sessionId);
  for (const timer of story.timers) clearTimeout(timer);
  story.timers = [];
  const run = currentRun(sessionId);
  if (run?.busy) {
    say(sessionId, user([{ type: 'text', text: '[Request interrupted by user]' }]));
    end(sessionId, run);
  }
  return { ok: true };
}

/** The run without a task Claude left running, and without what that task last reported. */
function without(run: RunState, taskId: string): RunState {
  const { tasks = [], progress, ...rest } = run;
  const task = tasks.find((t) => t.id === taskId);
  const left = tasks.filter((t) => t !== task);
  const reports = progress && Object.fromEntries(Object.entries(progress).filter(([call]) => call !== task?.toolUseId));
  return { ...rest, ...(left.length > 0 ? { tasks: left } : {}), ...(reports && Object.keys(reports).length > 0 ? { progress: reports } : {}) };
}

const DEMO_AGENTS: DemoAgent[] = [LICENSES, OUTDATED];

/** How long the demo's agent has been at work: since Claude Code said it began it, in the conversation. */
function ranFor(sessionId: string, agent: DemoAgent): number {
  const launched = getView(sessionId).messages.find((m) => m.blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === agent.call))?.timestamp;
  return launched ? Math.max(0, Date.now() - launched) : 0;
}

/**
 * The demo's agent still at work finishes a while after its session is first opened, as Claude Code
 * tells it: its report handed back, the notice of its end, and Claude's answer to it. Not once it
 * was stopped.
 */
let agentFinishing: ReturnType<typeof setTimeout> | undefined;
function finishAgentLater(): void {
  agentFinishing ??= setTimeout(() => {
    const sessionId = AGENTS_SESSION;
    const run = currentRun(sessionId);
    const task = run?.tasks?.find((t) => t.toolUseId === OUTDATED.call);
    // Its session let go of meanwhile: when it is opened again. Stopped: never.
    if (!run) agentFinishing = undefined;
    if (!run || !task) return;
    say(sessionId, user([{ type: 'text', text: handbackText(OUTDATED) }], { meta: true, handback: { from: OUTDATED.agentId, report: OUTDATED.report } }));
    say(sessionId, user([{ type: 'text', text: agentNotice(OUTDATED, 'completed', { ...OUTDATED.usage, durationMs: ranFor(sessionId, OUTDATED) }) }]));
    // Claude takes the notice in, as a turn of its own.
    runAs(sessionId, { ...without(run, task.id), busy: true, permissions: [], partial: [] });
    later(sessionId, 1600, () => {
      say(sessionId, assistant([{ type: 'text', text: OUTDATED.reply }]));
      finish(sessionId, 1600);
    });
  }, OUTDATED_FINISHES_MS);
}

/** A workflow stopped as Claude Code stops one: the agents still at work stop with it. */
const stopped = (workflow: Workflow): Workflow => ({
  ...workflow,
  status: 'killed',
  ...(workflow.startedAt !== undefined ? { durationMs: Date.now() - workflow.startedAt } : {}),
  agents: workflow.agents.map((a) => (a.state === 'start' || a.state === 'progress' ? { ...a, state: 'error', error: 'Stopped because the workflow was stopped' } : a)),
});

/**
 * Stop on a command, a workflow or an agent Claude left running: it ends, and the session has
 * nothing left at work. An agent's end is said in the conversation, as Claude Code says it.
 */
function stopTask(sessionId: string, taskId: string): { ok: boolean } {
  const run = currentRun(sessionId);
  const task = run?.tasks?.find((t) => t.id === taskId);
  if (!run || !task) return { ok: true };
  const rest = without(run, taskId);
  const workflows = rest.workflows && Object.fromEntries(Object.entries(rest.workflows).map(([call, w]) => [call, w.taskId === taskId && isLive(w.status) ? stopped(w) : w]));
  runAs(sessionId, { ...rest, ...(workflows ? { workflows } : {}) });
  const agent = DEMO_AGENTS.find((a) => a.call === task.toolUseId);
  if (agent) say(sessionId, user([{ type: 'text', text: agentNotice(agent, 'killed') }]));
  return { ok: true };
}

/** A queued message taken back before Claude gets it: dropped, or put back in the box to edit. */
function unqueue(sessionId: string, uuid: string): { ok: boolean } {
  const run = currentRun(sessionId);
  if (!run?.queued?.some((p) => p.uuid === uuid)) throw new ApiError('That message is no longer waiting', 409);
  const left = run.queued.filter((p) => p.uuid !== uuid);
  const { queued: _taken, ...rest } = run;
  runAs(sessionId, left.length > 0 ? { ...rest, queued: left } : rest);
  return { ok: true };
}

/** A message the user typed, as the demo tells one: words or a picture, not a tool's result. */
const typed = (m: ChatMessage) => m.role === 'user' && !m.meta && m.blocks.some((b) => b.type === 'text' || b.type === 'image');

/**
 * What Rewind to here would put back: the files Claude changed after the prompt, as far as the page
 * shows; and, for the conversation's first message, why only its code can go back.
 */
export function rewindPreview(messages: ChatMessage[], uuid: string): RewindCheck {
  const at = messages.findIndex((m) => m.uuid === uuid || m.sourceUuid === uuid);
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const message of at < 0 ? [] : messages.slice(at + 1)) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || !FILE_TOOLS.has(block.name)) continue;
      const file = str(block.input.file_path) || str(block.input.notebook_path);
      if (!file) continue;
      files.add(file);
      // Counted as the rewind would change them: what Claude added goes, what it replaced comes back.
      if (block.name === 'Write') deletions += lines(str(block.input.content));
      const edits = Array.isArray(block.input.edits) ? (block.input.edits as Array<Record<string, unknown>>) : [block.input];
      for (const edit of edits) {
        const { added, removed } = changedLines(str(edit.old_string), str(edit.new_string));
        insertions += removed;
        deletions += added;
      }
    }
  }
  const first = at >= 0 && !messages.slice(0, at).some(typed);
  return { files: [...files], insertions, deletions, ...(first ? { conversationStays: FIRST_MESSAGE } : {}) };
}

/** A prompt's words, as it was sent: its text, without the block that names the files sent with it. */
const wordsOf = (message: ChatMessage) => splitFiles(message.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n')).text;

/**
 * The conversation as the demo has it now: up to where it rewound it, and what was sent since. The
 * cut is the demo's own record, as it is Pelican's, until Undo rewind.
 */
function shown(story: Story | undefined, messages: ChatMessage[]): ChatMessage[] {
  const cut = story?.cut;
  if (!cut) return messages;
  const at = messages.findIndex((m) => m.uuid === cut.prompt || m.sourceUuid === cut.prompt);
  if (at < 0) return messages;
  const kept = messages.slice(0, at);
  return [...kept, ...story.added.slice(cut.added).filter((m) => !kept.includes(m))];
}

const rewoundOf = (story: Story | undefined): Rewound | undefined => (story?.cut && !story.cut.spent ? { prompt: story.cut.prompt, at: story.cut.at } : undefined);

/**
 * Rewind to here, acted out in the page: the conversation goes back to before the prompt, whose
 * words come back for the box; the code, as the demo has none to change, goes back in words only.
 */
function rewind(sessionId: string, body: Record<string, unknown>): RewindCheck | RewindDone {
  const messages = getView(sessionId).messages;
  const uuid = str(body.uuid);
  if (currentRun(sessionId)?.busy) throw new ApiError(REWIND_BUSY, 409);
  const prompt = messages.find((m) => m.uuid === uuid && typed(m));
  if (!prompt) throw new ApiError(NOT_HERE, 404);
  const check = rewindPreview(messages, uuid);
  if (body.dryRun === true) return check;
  const code = body.restore === 'conversation' ? {} : { files: check.files, insertions: check.insertions, deletions: check.deletions };
  if (body.restore === 'code') return code;
  if (check.conversationStays) throw new ApiError(check.conversationStays, 409);
  const story = storyOf(sessionId);
  story.cut = { prompt: uuid, at: Date.now(), added: story.added.length };
  return { ...code, prompt: { text: wordsOf(prompt), attachments: [] } };
}

/** Undo rewind: the messages come back, until the next message. */
function undoRewind(sessionId: string): { ok: boolean } {
  const story = stories.get(sessionId);
  if (!story?.cut || story.cut.spent) throw new ApiError(NOTHING_TO_UNDO, 409);
  delete story.cut;
  return { ok: true };
}

/**
 * Fork, and Fork from here, acted out in the page: a session of the demo's own with the
 * conversation copied up to just before a prompt (whose words come back for its box), up to a
 * reply, or whole, as it reads now. Before the first prompt there is nothing to copy.
 */
function fork(sessionId: string, body: Record<string, unknown>): { sessionId: string | null; prompt?: { text: string; attachments: [] } } {
  const messages = getView(sessionId).messages;
  const before = str(body.before);
  const upTo = str(body.upTo);
  let copy = messages;
  let prompt: { text: string; attachments: [] } | undefined;
  if (before || upTo) {
    const at = messages.findIndex((m) => m.uuid === (before || upTo));
    if (at < 0) throw new ApiError(NOT_HERE, 404);
    copy = messages.slice(0, before ? at : at + 1);
    if (before) prompt = { text: wordsOf(messages[at]!), attachments: [] };
  }
  if (!copy.some(typed)) return { sessionId: null, ...(prompt ? { prompt } : {}) };
  const id = newId();
  const cwd = folders.get(sessionId) ?? '';
  folders.set(id, cwd);
  const story = storyOf(id);
  story.summary = {
    id,
    title: `${titles.get(sessionId) ?? stories.get(sessionId)?.summary?.title ?? 'Session'} (fork)`,
    cwd,
    project: cwd.split('/').filter(Boolean).at(-1) ?? '',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    status: 'idle',
  };
  story.added = copy.map((m) => ({ ...m }));
  story.copyOf = sessionId;
  return { sessionId: id, ...(prompt ? { prompt } : {}) };
}

/**
 * What each turn of a session the demo made changed: none of a new one's own; of a copy, the turns
 * of its session it holds, with no copies of their files to rewind to, as forkSession copies none.
 */
async function changesOf(story: Story): Promise<SessionChanges> {
  if (!story.copyOf) return { turns: [], lines: {} };
  const source = await api.changes(story.copyOf).catch((): SessionChanges => ({ turns: [], lines: {} }));
  const held = new Set(story.added.map((m) => m.uuid));
  return { turns: source.turns.filter((turn) => held.has(turn.uuid)).map((turn) => ({ ...turn, checkpoint: false })), lines: source.lines };
}

const statusOf = (run: RunState): SessionStatus => (run.permissions.length > 0 ? 'waiting' : run.busy ? 'running' : 'idle');

function lastReply(messages: ChatMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.blocks.find((b) => b.type === 'text');
    if (text?.type === 'text') return text.text.replace(/\s+/g, ' ').slice(0, 200);
  }
  return undefined;
}

/** A session as the list shows it, with what the demo did to it. */
function summarize(session: SessionSummary): SessionSummary {
  const story = stories.get(session.id);
  if (!story) return session;
  const last = story.added.at(-1)?.timestamp ?? 0;
  const preview = lastReply(story.added);
  const working = story.run && !story.run.busy ? (story.run.tasks?.length ?? 0) + (story.run.scheduled?.length ?? 0) : 0;
  const { tasks: _listed, ...rest } = session;
  return {
    ...(story.run ? rest : session),
    ...(story.run ? { status: statusOf(story.run), ...(working > 0 ? { tasks: working } : {}) } : {}),
    lastActivity: Math.max(session.lastActivity, last),
    ...(preview ? { preview } : {}),
  };
}

const sessionPath = /^sessions\/([^/?]+)(\/[^?]*)?(?:\?(.*))?$/;

/**
 * What new sessions start with in the demo: its server's answer (Claude Code's own defaults, from
 * no file), then what was changed here, in the page alone. No settings file is read or written.
 */
let startDefaults: StartDefaults | undefined;
let changedDefaults = false;
let demoModels: ModelOption[] | undefined;

function changeDefaults(body: Record<string, unknown>): StartDefaults {
  if (!startDefaults) throw new DemoRefusal(DEMO_NOTE);
  const next = structuredClone(startDefaults);
  const effort = body.effort as { model?: unknown; level?: unknown } | undefined;
  if (typeof body.model === 'string') next.model = body.model === 'default' ? { value: 'default', source: 'built-in' } : { value: body.model, source: 'user' };
  else if (effort && typeof effort.model === 'string') {
    const key = modelKey(effort.model, demoModels);
    if (isSavedEffort(effort.level)) next.effort.byModel[key] = { level: effort.level, source: 'user' };
    else delete next.effort.byModel[key];
  } else if (typeof body.fast === 'boolean') next.fast = { value: body.fast, source: body.fast ? 'user' : 'built-in', perSession: false };
  else if (isPermissionMode(body.permissionMode) && body.permissionMode !== 'bypassPermissions') next.permissionMode = { value: body.permissionMode, source: 'user' };
  else throw new DemoRefusal(DEMO_NOTE);
  startDefaults = next;
  changedDefaults = true;
  return next;
}

function read(path: string): Promise<unknown> | undefined {
  if (changedDefaults && /^defaults(\?|$)/.test(path)) return Promise.resolve(startDefaults);
  // A pull request the demo made in the page: as made up as the rest.
  if (path.startsWith('pr?')) {
    const made = demoPulls.get(new URLSearchParams(path.slice(3)).get('url') ?? '');
    if (made) return Promise.resolve(made);
  }
  const match = sessionPath.exec(path);
  const id = match ? decodeURIComponent(match[1]!) : undefined;
  const story = id ? stories.get(id) : undefined;
  if (!id || !story?.summary) return undefined;
  const rest = match![2] ?? '';
  if (rest === '') return Promise.resolve({ session: summarize(story.summary), run: story.run ?? null, tasks: currentTasks(story.added), settings: {} });
  if (rest === '/messages') {
    const messages = shown(story, story.added);
    const rewound = rewoundOf(story);
    return Promise.resolve({ messages, total: messages.length, offset: 0, ...(rewound ? { rewound } : {}) } satisfies MessagesPage);
  }
  if (rest === '/mcp') return Promise.resolve({ servers: [], live: false });
  if (rest === '/changes') return changesOf(story);
  return undefined;
}

function adjust(path: string, data: unknown): unknown {
  if (path === 'models') demoModels = (data as { models?: ModelOption[] }).models;
  if (/^defaults(\?|$)/.test(path) && !changedDefaults) startDefaults = data as StartDefaults;
  if (path === 'sessions') {
    const { sessions } = data as { sessions: SessionSummary[] };
    for (const session of sessions) {
      folders.set(session.id, session.cwd);
      titles.set(session.id, session.title);
      if (session.sideChatOf) sideChats.add(session.id);
    }
    const started = [...stories.values()].flatMap((story) => (story.summary ? [story.summary] : []));
    return { sessions: [...started, ...sessions].map(summarize).sort((a, b) => b.lastActivity - a.lastActivity) };
  }
  const match = sessionPath.exec(path);
  // Its agent at work finishes a while after the session is first opened.
  if (match && decodeURIComponent(match[1]!) === AGENTS_SESSION && !match[2]) finishAgentLater();
  const story = match ? stories.get(decodeURIComponent(match[1]!)) : undefined;
  if (!story) return data;
  const rest = match![2] ?? '';
  if (rest === '') {
    const detail = data as { session: SessionSummary | null; run: RunState | null };
    return { ...detail, ...(detail.session ? { session: summarize(detail.session) } : {}), ...(story.run ? { run: story.run } : {}) };
  }
  // The newest page gets what the demo added since, so loading it again keeps them.
  if (rest === '/messages' && !new URLSearchParams(match![3] ?? '').has('before')) {
    const page = data as MessagesPage;
    const have = new Set(page.messages.map((m) => m.uuid));
    const added = story.added.filter((m) => !have.has(m.uuid));
    const all = [...page.messages, ...added];
    const messages = shown(story, all);
    const rewound = rewoundOf(story);
    return { ...page, messages, total: page.total + added.length - (all.length - messages.length), ...(rewound ? { rewound } : {}) };
  }
  return data;
}

async function answer(path: string, init: RequestInit): Promise<unknown> {
  const body = (typeof init.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;
  const match = sessionPath.exec(path);
  const id = match ? decodeURIComponent(match[1]!) : undefined;
  const rest = match?.[2] ?? '';
  if (path === 'sessions' && init.method === 'POST') return create(body as SendBody);
  if (path === 'defaults') return changeDefaults(body);
  if (id && rest === '/messages') return send(id, body as SendBody);
  if (id && rest === '/side') return side(id, body as { question?: string; uuid?: string; settings?: RunSettings });
  if (id && rest.startsWith('/permissions/')) return decide(id, decodeURIComponent(rest.slice('/permissions/'.length)), body as PermissionDecision);
  if (id && rest === '/interrupt') return interrupt(id);
  if (id && rest.startsWith('/queued/')) return unqueue(id, decodeURIComponent(rest.slice('/queued/'.length)));
  if (id && rest === '/rewind') return rewind(id, body);
  if (id && rest === '/rewind/undo') return undoRewind(id);
  if (id && rest === '/fork') return fork(id, body);
  if (id && (rest === '/settings' || rest === '/mode')) {
    const run = currentRun(id);
    const settings = rest === '/mode' ? { ...run?.settings, permissionMode: body.permissionMode as RunSettings['permissionMode'] } : (body.settings as RunSettings);
    if (run) runAs(id, { ...run, settings });
    return { ok: true };
  }
  if (id && rest.startsWith('/tasks/')) return stopTask(id, decodeURIComponent(rest.split('/')[2] ?? ''));
  throw new DemoRefusal(DEMO_NOTE);
}

/** From now on the demo answers in the page; see above. */
export function startDemo(info: ServerInfo): void {
  home = info.home;
  answerLocally({ answer, read, adjust });
}

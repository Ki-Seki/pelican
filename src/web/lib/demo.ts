import { useSyncExternalStore } from 'react';

import type {
  Block, ChatMessage, MessagesPage, PermissionDecision, PermissionRequest, RewindResult, RunSettings, RunState, SendMode, ServerInfo, SessionStatus, SessionSummary, Workflow,
} from '../../shared/protocol';
import { currentTasks, type Todo } from '../../shared/tasks';
import { isLive } from '../../shared/workflows';
import { shortTitle } from '../../shared/titles';
import { answerLocally, ApiError } from './api';
import { newId } from './ids';
import { DEMO_NOTE, DemoRefusal, INSTALL_URL, STATIC_DEMO } from './static-demo';
import { addLocalMessage, getView, setRun } from './store';

/**
 * The demo acts out the two moments it exists to show, and says calmly what it cannot do. Allow
 * on the waiting edit plays out the rest of that step: the edit lands, the next task starts and
 * Claude says what it did. A message gets a reply that says what Claude would do with it. Anything
 * else that would change something gets the one demo note. Both demos run this: the site's, which
 * has no server, and `pelican --demo`, whose server runs nothing; nothing here leaves the page.
 */

type Story = {
  /** The run as the demo has it now, over the server's. */
  run?: RunState;
  /** What the demo added to the conversation, oldest first. */
  added: ChatMessage[];
  timers: ReturnType<typeof setTimeout>[];
  /** A session the demo started itself. */
  summary?: SessionSummary;
};

const stories = new Map<string, Story>();
const folders = new Map<string, string>();
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
  const words = stories.get(sessionId)?.summary?.sideChatOf ? DEMO_SIDE_REPLY : DEMO_REPLY;
  later(sessionId, 1400, () => {
    say(sessionId, assistant([{ type: 'text', text: words }]));
    finish(sessionId, 1400);
  });
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
  if (!run) runAs(sessionId, idleRun(sessionId, body.settings));
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
  runAs(id, idleRun(id, body.settings));
  reply(id, user(body.text ? [{ type: 'text', text: body.text }] : [], { uuid: body.uuid }));
  return { sessionId: id };
}

/** A side question: a side chat of the session's, started in the page like a new session, listed under it. */
function side(sessionId: string, body: { question?: string; uuid?: string; settings?: RunSettings }): { sessionId: string } {
  const id = newId();
  const cwd = folders.get(sessionId) ?? '';
  folders.set(id, cwd);
  storyOf(id).summary = {
    id,
    title: 'Side chat',
    cwd,
    project: cwd.split('/').filter(Boolean).at(-1) ?? '',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    status: 'running',
    sideChatOf: sessionId,
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

/** A workflow stopped as Claude Code stops one: the agents still at work stop with it. */
const stopped = (workflow: Workflow): Workflow => ({
  ...workflow,
  status: 'killed',
  ...(workflow.startedAt !== undefined ? { durationMs: Date.now() - workflow.startedAt } : {}),
  agents: workflow.agents.map((a) => (a.state === 'start' || a.state === 'progress' ? { ...a, state: 'error', error: 'Stopped because the workflow was stopped' } : a)),
});

/** Stop on a command or a workflow Claude left running: it ends, and the session has nothing left at work. */
function stopTask(sessionId: string, taskId: string): { ok: boolean } {
  const run = currentRun(sessionId);
  if (!run?.tasks?.some((t) => t.id === taskId)) return { ok: true };
  const { tasks, ...rest } = run;
  const left = tasks.filter((t) => t.id !== taskId);
  const workflows = rest.workflows && Object.fromEntries(Object.entries(rest.workflows).map(([call, w]) => [call, w.taskId === taskId && isLive(w.status) ? stopped(w) : w]));
  runAs(sessionId, { ...(left.length > 0 ? { ...rest, tasks: left } : rest), ...(workflows ? { workflows } : {}) });
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

/** What Rewind would put back: the files Claude changed after the prompt, as far as the page shows. */
export function rewindPreview(messages: ChatMessage[], uuid: string): RewindResult {
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
  return files.size > 0 ? { canRewind: true, files: [...files], insertions, deletions } : { canRewind: false };
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

function read(path: string): Promise<unknown> | undefined {
  const match = sessionPath.exec(path);
  const id = match ? decodeURIComponent(match[1]!) : undefined;
  const story = id ? stories.get(id) : undefined;
  if (!id || !story?.summary) return undefined;
  const rest = match![2] ?? '';
  if (rest === '') return Promise.resolve({ session: summarize(story.summary), run: story.run ?? null, tasks: currentTasks(story.added), settings: {} });
  if (rest === '/messages') return Promise.resolve({ messages: story.added, total: story.added.length, offset: 0 } satisfies MessagesPage);
  if (rest === '/mcp') return Promise.resolve({ servers: [], live: false });
  return undefined;
}

function adjust(path: string, data: unknown): unknown {
  if (path === 'sessions') {
    const { sessions } = data as { sessions: SessionSummary[] };
    for (const session of sessions) folders.set(session.id, session.cwd);
    const started = [...stories.values()].flatMap((story) => (story.summary ? [story.summary] : []));
    return { sessions: [...started, ...sessions].map(summarize).sort((a, b) => b.lastActivity - a.lastActivity) };
  }
  const match = sessionPath.exec(path);
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
    return { ...page, messages: [...page.messages, ...added], total: page.total + added.length };
  }
  return data;
}

async function answer(path: string, init: RequestInit): Promise<unknown> {
  const body = (typeof init.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;
  const match = sessionPath.exec(path);
  const id = match ? decodeURIComponent(match[1]!) : undefined;
  const rest = match?.[2] ?? '';
  if (path === 'sessions' && init.method === 'POST') return create(body as SendBody);
  if (id && rest === '/messages') return send(id, body as SendBody);
  if (id && rest === '/side') return side(id, body as { question?: string; uuid?: string; settings?: RunSettings });
  if (id && rest.startsWith('/permissions/')) return decide(id, decodeURIComponent(rest.slice('/permissions/'.length)), body as PermissionDecision);
  if (id && rest === '/interrupt') return interrupt(id);
  if (id && rest.startsWith('/queued/')) return unqueue(id, decodeURIComponent(rest.slice('/queued/'.length)));
  if (id && rest === '/rewind' && body.dryRun === true) return rewindPreview(getView(id).messages, str(body.uuid));
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

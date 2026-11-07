import { errorLine, nextStep } from '../../shared/errors';
import type { AgentLaunch, ChatMessage, ImageBlock, ToolResultBlock, TurnChanges } from '../../shared/protocol';
import { launchOf, parseTaskNotice, type TaskNotice, workflowOf } from '../../shared/workflows';

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultBlock;
  /** A Workflow call, or an Agent call whose agent ran in the background: how Claude Code said it ended, in the conversation. */
  ended?: TaskNotice;
  /** A Workflow call whose run a later call resumed (its id): that call's card shows the run. */
  resumedBy?: string;
  /** An Agent call: the report its agent handed back, which Claude Code gives Claude as a message of its own. */
  report?: string;
};

/** Where a notice about a workflow's end leads: its card, and what the line says of it. */
export type WorkflowNotice = { toolUseId: string; name?: string; status?: TaskNotice['status']; durationMs?: number };

/**
 * Where a notice about a background agent's end leads: its card, and what the line says of it, in
 * Claude Code's words after the agent's name ("finished", "failed", "was stopped by user").
 */
export type AgentNotice = { toolUseId: string; description?: string; status?: TaskNotice['status']; words: string; durationMs?: number };

/**
 * How an Agent call ran its agent: waiting for it (`background` false), or not (in the background
 * here, in a cloud session, as a teammate), as Claude Code recorded it or, from a transcript that
 * kept no record, as its words to Claude say. `agentId`: the agent's own transcript and task.
 */
export type AgentRun = { background: boolean; mode?: AgentLaunch['mode']; agentId?: string; sessionUrl?: string; name?: string };

/** Claude Code's first words to Claude for an Agent call that does not wait for its agent: the rest is for the model alone. */
const LAUNCHED = /^\s*(Async agent launched successfully\.|Cloud agent launched\.|Spawned successfully\.)/;
const LAUNCH_MODE: Record<string, AgentLaunch['mode']> = { 'Async agent launched successfully.': 'background', 'Cloud agent launched.': 'cloud', 'Spawned successfully.': 'teammate' };

export function agentOf(call: ToolCall): AgentRun {
  if (call.name !== 'Agent' && call.name !== 'Task') return { background: false };
  const result = call.result;
  const text = resultText(result);
  const said = result && !result.is_error ? LAUNCHED.exec(text)?.[1] : undefined;
  const launch = result?.agent;
  const mode = launch?.mode ?? (said ? LAUNCH_MODE[said] : undefined);
  // The launch's own line, or the trailer of a finished agent's result, after its report: "agentId: a1b2… (…)".
  const agentId = launch?.agentId ?? [...text.matchAll(/(?:^|\n)agent_?[iI]d: ([\w-]{1,80})/g)].at(-1)?.[1];
  const sessionUrl = launch?.sessionUrl ?? (mode === 'cloud' ? /(?:^|\n)session_url: (https:\/\/\S+)/.exec(text)?.[1] : undefined);
  return {
    background: Boolean(mode),
    ...(mode ? { mode } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionUrl ? { sessionUrl } : {}),
    ...(launch?.name ? { name: launch.name } : {}),
  };
}

/** An Agent call that runs, or will run, its agent in the background: its card is a block of its own. */
export const runsInBackground = (call: ToolCall): boolean => (call.name === 'Agent' || call.name === 'Task') && (call.input.run_in_background === true || agentOf(call).background);

/**
 * What Claude Code gives Claude in place of an agent's report it handed back as a message of its
 * own: a pointer to that message, for the model. The report shows instead, where it is known.
 */
export const HANDED_BACK = /^\s*This agent's report was delivered to you as a message from "[\w-]+"/;

/** What Claude Code says after an agent's name, in a notice of its end ("Agent "Review" finished"): its words alone. */
function agentWords(task: TaskNotice, description: string | undefined): string {
  const summary = task.summary.trim();
  const named = description ? `Agent "${description}" ` : undefined;
  if (named && summary.startsWith(named)) return summary.slice(named.length);
  const said = /^(?:Agent|Remote task) "[\s\S]*" ((?:finished|completed|failed|was stopped|is waiting|stopped at|is blocked)[\s\S]*)$/.exec(summary)?.[1];
  if (said) return said;
  return task.status === 'completed' ? 'finished' : task.status === 'failed' ? 'failed' : 'was stopped';
}

export type Part =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall }
  | { kind: 'image'; key: string; image: ImageBlock };

/** A file sent with a prompt; `id` is its upload and `path` where Claude reads it, once the server has written the prompt down. */
export type SentFile = { name: string; id?: string; path?: string };

export type Item =
  | {
    kind: 'user';
    key: string;
    text: string;
    images: ImageBlock[];
    files: SentFile[];
    command?: { name: string; args: string };
    timestamp?: number;
    pending?: boolean;
    queued?: boolean;
    steered?: boolean;
  }
  | { kind: 'assistant'; key: string; parts: Part[]; timestamp?: number; model?: string }
  | {
    kind: 'notice'; key: string; tone: 'output' | 'task' | 'interrupt' | 'info' | 'error'; text: string; detail?: string;
    /** For an API error: what can be done about it from here. */
    next?: 'compact' | 'retry';
    /** A workflow's end, shown in its card: the line leads there. */
    workflow?: WorkflowNotice;
    /** A background agent's end, shown in its card: the line leads there. */
    agent?: AgentNotice;
  }
  | { kind: 'compact'; key: string; summary: string }
  /**
   * `saved`: the file Claude Code saved all of a long output in, by its name in the session's
   * tool-results folder. `ended`: the record says it did not go well, as Claude Code's does.
   */
  | { kind: 'shell'; key: string; command: string; stdout: string; stderr: string; saved?: string; ended?: ShellEnd; timestamp?: number }
  | { kind: 'day'; key: string; timestamp: number };

const tag = (text: string, name: string) => {
  const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match?.[1]?.trim();
};

/* eslint-disable no-control-regex */
/**
 * Output as a terminal would leave it on screen: colors, links and other escape codes gone (a
 * link keeps its text), a line rewritten with \r (a progress bar) as it ended, and Claude Code's
 * error tags taken off.
 */
export function cleanOutput(text: string): string {
  const unwrapped = text.match(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/)?.[1] ?? text;
  return unwrapped
    // OSC, DCS and the like run to BEL or ST; one cut off ends at the line's end.
    .replace(/\u001b[P\]X^_][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[0-~]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.split('\r').filter(Boolean).at(-1) ?? '' : line))
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
/* eslint-enable no-control-regex */

/** How a `!` command's record says it ended, when not well: it failed, or Pelican stopped it. */
export type ShellEnd = 'failed' | 'stopped';

type Recorded = { stdout: string; stderr: string; saved?: string; ended?: ShellEnd };

type Classified =
  | { kind: 'user'; text: string; images: ImageBlock[]; command?: { name: string; args: string } }
  | { kind: 'notice'; tone: 'output' | 'task' | 'interrupt' | 'info'; text: string; detail?: string; task?: TaskNotice }
  | ({ kind: 'shell'; command: string } & Recorded)
  /** The output of the `!` command just before, in a message of its own, as Claude Code writes it. */
  | ({ kind: 'shell-output' } & Recorded);

/**
 * The files sent with a prompt, out of its text. Pelican tells Claude where they are in an
 * "Attached files:" block of paths, which is for Claude, not for reading; a prompt still on its
 * way names them on lines of their own, "📎 name".
 */
export function splitFiles(text: string, pending = false): { text: string; files: SentFile[] } {
  const block = text.match(/(?:^|\n\n)Attached files:\n((?:- .+ \(.+\)(?:\n|$))+)$/);
  if (block) {
    const files = block[1]!.trimEnd().split('\n').map((line): SentFile => {
      // The path ends in the file's own name, which may hold " (" itself.
      const upload = line.match(/^- (.*\/uploads\/([0-9a-f-]{36})\/(.+)) \(\3\)$/);
      if (upload) return { name: upload[3]!, id: upload[2]!, path: upload[1]! };
      const other = line.match(/^- (.+) \((.+)\)$/);
      return other ? { name: other[2]!, path: other[1]! } : { name: line.slice(2) };
    });
    return { text: text.slice(0, block.index).trimEnd(), files };
  }
  if (pending) {
    const lines = text.split('\n');
    let at = lines.length;
    while (at > 0 && lines[at - 1]!.startsWith('📎 ')) at -= 1;
    if (at < lines.length) return { text: lines.slice(0, at).join('\n').trimEnd(), files: lines.slice(at).map((line) => ({ name: line.slice(3) })) };
  }
  return { text, files: [] };
}

/** A prompt's text with its files' block put back, for sending it again with the same files. */
export function withFiles(text: string, files: SentFile[]): string {
  const lines = files.flatMap((file) => (file.path ? [`- ${file.path} (${file.name})`] : []));
  return lines.length > 0 ? `${text}${text ? '\n\n' : ''}Attached files:\n${lines.join('\n')}` : text;
}

const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A file Claude Code names in a session's tool-results folder, as the server reads one. */
const SAVED_NAME = /^[A-Za-z0-9_-]{1,128}\.(?:txt|json)$/;

/**
 * A `!` command's output as it shows: unescaped, or, for one too long for the conversation, what
 * Claude Code saved in its place (`<persisted-output>`, written as it came) unwrapped: the start
 * Claude got, then Claude Code's line saying where all of it is, with that file's name (`saved`).
 */
function shellOutput(raw: string): { text: string; saved?: string } {
  const persisted = /^<persisted-output>\n([^\n]*)\n\n(?:Preview \([^)\n]*\):\n)?([\s\S]*?)\n?<\/persisted-output>$/.exec(raw);
  if (!persisted) return { text: unescape(raw) };
  const name = /saved to: (.+)$/.exec(persisted[1]!)?.[1]?.split(/[\\/]/).at(-1);
  return { text: `${persisted[2]!.replace(/\n+$/, '')}\n${persisted[1]}`, ...(name && SAVED_NAME.test(name) ? { saved: name } : {}) };
}

/**
 * The output of a `!` command's record, as the card shows it: Claude Code's word that a command
 * printed nothing is for Claude, and the card shows nothing in its place. How it ended, as the
 * record tells it: Claude Code's bash mode puts the output of one that went well under stdout, or
 * its word that it printed none, and that of one that failed under stderr, with stdout empty; one
 * Pelican stopped says so at its end. Before Claude Code 2.1.80, and in Pelican's records before
 * 0.4 (one message, with "(exit code N)" at the end of a failed one's stderr), a command that went
 * well could leave stdout empty too: those say how they ended only by such a note.
 */
function shellRecord(text: string, version?: string): Recorded {
  const out = tag(text, 'bash-stdout');
  const err = tag(text, 'bash-stderr');
  const stdout = shellOutput(out ?? '');
  const stderr = shellOutput(err ?? '');
  const saved = stdout.saved ?? stderr.saved;
  const note = /(?:^|\n)\((stopped(?: after [^)\n]+)?|exit code -?\d+)\)$/.exec(stderr.text)?.[1];
  const shaped = err !== undefined && !out && sharesStdoutOnSuccess(version);
  const ended: ShellEnd | undefined = note?.startsWith('stopped') ? 'stopped' : note || shaped ? 'failed' : undefined;
  return { stdout: stdout.text === '(Bash completed with no output)' ? '' : stdout.text, stderr: stderr.text, ...(saved ? { saved } : {}), ...(ended ? { ended } : {}) };
}

/** Whether a Claude Code's `!` output row says under stdout that a command went well: 2.1.80 on. */
function sharesStdoutOnSuccess(version: string | undefined): boolean {
  const [major, minor, patch] = (version ?? '').split('.').map((n) => Number.parseInt(n, 10));
  if (major === undefined || minor === undefined || patch === undefined || [major, minor, patch].some(Number.isNaN)) return false;
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 80)));
}

/** Splits what Claude Code wraps in tags out of a user message's text. */
function classifyUserText(raw: string, version?: string): Classified | undefined {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return undefined;
  if (text.includes('<local-command-caveat>')) return undefined;
  // A `!` command and its output (Claude Code's bash mode), from any client.
  const bash = tag(text, 'bash-input');
  // One message holding the command and its output is a record of Pelican's before 0.4 (or another
  // client's): only a note at its end says it did not go well.
  if (bash !== undefined) return { kind: 'shell', command: unescape(bash), ...shellRecord(text) };
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return { kind: 'shell-output', ...shellRecord(text, version) };
  const commandName = tag(text, 'command-name');
  if (commandName) {
    return { kind: 'user', text: '', images: [], command: { name: commandName, args: tag(text, 'command-args') ?? '' } };
  }
  const stdout = tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr');
  if (stdout !== undefined) {
    const clean = cleanOutput(stdout).trim();
    return clean ? { kind: 'notice', tone: 'output', text: clean } : undefined;
  }
  const task = parseTaskNotice(text);
  if (task) return { kind: 'notice', tone: 'task', text: task.summary || 'Background task update', ...(task.result ? { detail: task.result } : {}), task };
  if (/^\[Request interrupted by user/.test(text)) return { kind: 'notice', tone: 'interrupt', text: 'Interrupted' };
  return { kind: 'user', text, images: [] };
}

const dayOf = (ms: number) => new Date(ms).toDateString();

/**
 * Groups a conversation into what the chat shows: prompts, Claude's turns, and notices.
 * `machine`: the computer Claude Code runs on, named where an error line says what to do there.
 */
export function buildItems(messages: ChatMessage[], machine?: string): Item[] {
  const results = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    for (const block of message.blocks) if (block.type === 'tool_result') results.set(block.tool_use_id, block);
  }

  const items: Item[] = [];
  /** The `!` commands whose output has been seen: what comes after it is not theirs. */
  const withOutput = new Set<string>();
  let turn: Extract<Item, { kind: 'assistant' }> | undefined;
  let lastDay: string | undefined;
  /** Workflow calls so far, by id, for their ends to join them; and each run's calls, in order. */
  const workflows = new Map<string, ToolCall>();
  const runs = new Map<string, ToolCall[]>();
  /** Agent calls so far, by id and by their agent's, for their ends and their reports to join them. */
  const agents = new Map<string, ToolCall>();
  const agentIds = new Map<string, ToolCall>();

  // The day goes above the conversation's first message and above each prompt on a new day, as
  // Claude Desktop shows it.
  const push = (item: Item, timestamp?: number) => {
    if (timestamp && (item.kind === 'user' || !lastDay)) {
      const day = dayOf(timestamp);
      if (day !== lastDay) items.push({ kind: 'day', key: `day-${item.key}`, timestamp });
      lastDay = day;
    }
    items.push(item);
  };

  for (const message of messages) {
    if (message.parentToolUseId) continue;
    // A compaction's summary is injected text too, but it marks where Claude's memory was condensed.
    if (message.compactSummary) {
      const summary = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
      push({ kind: 'compact', key: message.uuid, summary });
      turn = undefined;
      continue;
    }
    if (message.meta) {
      // A subagent's report handed back, for the model: its Agent call's card shows it.
      const call = message.handback ? agentIds.get(message.handback.from) : undefined;
      if (call && call.report === undefined) call.report = message.handback!.report;
      continue;
    }
    // Lines Claude Code adds itself (a local command and its output, hook feedback): notes, never prompts.
    if (message.role === 'system') {
      const classified = classifyUserText(message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
      if (!classified) continue;
      if (classified.kind === 'user' && !classified.command) push({ kind: 'notice', key: message.uuid, tone: 'info', text: classified.text });
      else if (classified.kind === 'user') push({ ...classified, files: [], key: message.uuid, ...(message.timestamp ? { timestamp: message.timestamp } : {}) }, message.timestamp);
      else if (classified.kind === 'notice') push({ ...classified, key: message.uuid });
      turn = undefined;
      continue;
    }
    // A failed API call is not Claude's reply: one line saying what went wrong, in plain words.
    if (message.apiError) {
      const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
      push({ kind: 'notice', key: message.uuid, tone: 'error', text: errorLine(text, machine, message.error) ?? text, next: nextStep(text, message.error) });
      turn = undefined;
      continue;
    }
    if (message.role === 'user') {
      const texts = message.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : ''));
      const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image');
      if (texts.length === 0 && images.length === 0) continue;
      const classified: Classified | undefined = texts.length > 0 ? classifyUserText(texts.join('\n\n'), message.version) : { kind: 'user', text: '', images: [] };
      if (!classified) continue;
      if (classified.kind === 'user') {
        push({
          ...classified,
          ...splitFiles(classified.text, message.pending),
          key: message.uuid,
          images,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          ...(message.pending ? { pending: true } : {}),
          ...(message.queued ? { queued: true } : {}),
          ...(message.steered ? { steered: true } : {}),
        }, message.timestamp);
        turn = undefined;
      } else if (classified.kind === 'shell') {
        push({ ...classified, key: message.uuid, ...(message.timestamp ? { timestamp: message.timestamp } : {}) });
        // A record of the CLI's older shape holds its output with the command.
        if (texts.some((t) => /<bash-std(?:out|err)>/.test(t))) withOutput.add(message.uuid);
        turn = undefined;
      } else if (classified.kind === 'shell-output') {
        // It goes with its command; on its own, it is nothing to show.
        const last = items.at(-1);
        if (last?.kind === 'shell' && !withOutput.has(last.key)) {
          withOutput.add(last.key);
          last.stdout = classified.stdout;
          last.stderr = classified.stderr;
          if (classified.saved) last.saved = classified.saved;
          if (classified.ended) last.ended = classified.ended;
        }
      } else {
        // A workflow's end goes into its card; here a line names it and leads there. One from a
        // Claude Code that found the run without its end gives way to the word of the one that ran it.
        const { task, ...notice } = classified;
        const call = task?.toolUseId ? workflows.get(task.toolUseId) : undefined;
        // So does a background agent's: by its call, or by its agent where the notice names no call.
        const agent = task && !call ? (task.toolUseId ? agents.get(task.toolUseId) : task.taskId ? agentIds.get(task.taskId) : undefined) : undefined;
        if (call && task) {
          if (!call.ended || call.ended.orphan || !task.orphan) call.ended = task;
          const name = launchOf(call.result)?.name ?? workflowOf(call.input).name;
          const { detail: _shownInTheCard, ...line } = notice;
          push({
            ...line,
            key: message.uuid,
            workflow: { toolUseId: call.id, ...(name ? { name } : {}), ...(task.status ? { status: task.status } : {}), ...(task.usage?.durationMs !== undefined ? { durationMs: task.usage.durationMs } : {}) },
          });
        } else if (agent && task) {
          if (!agent.ended || agent.ended.orphan || !task.orphan) agent.ended = task;
          const description = typeof agent.input.description === 'string' && agent.input.description.trim() ? agent.input.description.trim() : undefined;
          const { detail: _shownInTheCard, ...line } = notice;
          push({
            ...line,
            key: message.uuid,
            agent: {
              toolUseId: agent.id,
              ...(description ? { description } : {}),
              ...(task.status ? { status: task.status } : {}),
              words: agentWords(task, description),
              ...(task.usage?.durationMs !== undefined ? { durationMs: task.usage.durationMs } : {}),
            },
          });
        } else {
          push({ ...notice, key: message.uuid });
        }
        // Claude's answer to a background task's note comes after the note, as a turn of its own.
        if (task || notice.tone === 'task') turn = undefined;
      }
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (!turn) {
      turn = {
        kind: 'assistant',
        key: message.uuid,
        parts: [],
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        ...(message.model ? { model: message.model } : {}),
      };
      push(turn, message.timestamp);
    }
    message.blocks.forEach((block, i) => {
      const key = `${message.uuid}:${i}`;
      if (block.type === 'text') turn!.parts.push({ kind: 'text', key, text: block.text });
      else if (block.type === 'thinking') turn!.parts.push({ kind: 'thinking', key, text: block.thinking });
      else if (block.type === 'image') turn!.parts.push({ kind: 'image', key, image: block });
      else if (block.type === 'tool_use') {
        const result = results.get(block.id);
        const call: ToolCall = { id: block.id, name: block.name, input: block.input, ...(result ? { result } : {}) };
        if (block.name === 'Workflow') {
          workflows.set(block.id, call);
          const runId = launchOf(result)?.runId;
          if (runId) runs.set(runId, [...(runs.get(runId) ?? []), call]);
        } else if (block.name === 'Agent' || block.name === 'Task') {
          agents.set(block.id, call);
          const agentId = agentOf(call).agentId;
          if (agentId) agentIds.set(agentId, call);
        }
        turn!.parts.push({ kind: 'tool', key, call });
      }
    });
  }
  // A run resumed by a later call (the same run id) is that call's to show.
  for (const calls of runs.values()) calls.slice(0, -1).forEach((call, i) => (call.resumedBy = calls[i + 1]!.id));
  return items;
}

/**
 * Where each turn's "files changed" goes: under the last of Claude's answers in it. Turns end
 * where Claude Code's /diff ends them (see changes.ts), at the next row it counts as a prompt: a
 * prompt with words, files or a `/` command, a `!` command, a background task's note, an
 * interruption, a compaction. A `/` command's output belongs to it, and a picture sent without
 * words is no new turn.
 */
export function filesChangedUnder(items: readonly Item[], turns: readonly TurnChanges[]): Map<string, TurnChanges> {
  const byStart = new Map(turns.map((turn) => [turn.uuid, turn]));
  const under = new Map<string, TurnChanges>();
  let start: string | undefined;
  let answer: string | undefined;
  const close = () => {
    const turn = start ? byStart.get(start) : undefined;
    if (turn && answer) under.set(answer, turn);
  };
  for (const item of items) {
    // A message of files alone is text to /diff: its "Attached files:" block.
    const starts = item.kind === 'user' ? !item.steered && (Boolean(item.text) || Boolean(item.command) || item.files.length > 0)
      : item.kind === 'notice' ? item.tone === 'task' || item.tone === 'interrupt'
        : item.kind === 'shell' || item.kind === 'compact';
    if (starts) {
      close();
      start = item.key;
      answer = undefined;
    } else if (item.kind === 'assistant') {
      answer = item.key;
    }
  }
  close();
  return under;
}

/** Text of a tool result, with images left out. */
export function resultText(result: ToolResultBlock | undefined): string {
  if (!result) return '';
  if (typeof result.content === 'string') return result.content;
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

export function resultImages(result: ToolResultBlock | undefined): ImageBlock[] {
  if (!result || typeof result.content === 'string') return [];
  return result.content.filter((part): part is ImageBlock => part.type === 'image');
}

/**
 * How a tool call ended. Refused (denied: by you, a rule or auto mode) and stopped (interrupted)
 * are not failures: the call never ran, or was cut short, and its result is only a note to Claude.
 */
export type Outcome =
  | { kind: 'pending' }
  | { kind: 'done' }
  | { kind: 'failed' }
  | { kind: 'denied'; note?: string }
  | { kind: 'stopped' };

// What Claude Code answers in place of a refused call, before the user's own words if any.
const REFUSED = [
  "The user doesn't want to proceed with this tool use.",
  'Permission for this tool use was denied.',
  'The agent proposed a plan that was rejected by the user.',
  'User rejected tool use',
];
const SAID = /[Tt]he user said:\n([\s\S]*)$/;
// What Pelican itself answered a refusal with, before it used Claude Code's words.
const PELICAN_REFUSED = new Set(['The user declined this.', 'The user chose not to answer.']);
// Claude Code's notes for a call cut short (Stop, a message that ended the turn, a session that
// ended), and Pelican's own for a request Stop or closing answered.
const STOPPED = /this call was stopped while running|^The user doesn't want to take this action right now\.|^\[(?:Request interrupted|Tool call|Agent call interrupted)|^Interrupted by the user\.$|^Cancelled\.$|^Session closed\.$/;

export function outcomeOf(call: ToolCall): Outcome {
  const result = call.result;
  if (!result) return { kind: 'pending' };
  if (!result.is_error) return { kind: 'done' };
  const text = resultText(result).trim();
  if (STOPPED.test(text)) return { kind: 'stopped' };
  if (REFUSED.some((start) => text.startsWith(start))) {
    // A plan sent back without a word carries the plan after it, which is not a note.
    const note = text.match(SAID)?.[1]?.trim();
    return { kind: 'denied', ...(note ? { note } : {}) };
  }
  if (PELICAN_REFUSED.has(text)) return { kind: 'denied' };
  // A refusal in other words (Pelican's with a note) is known by the transcript, or by the tool:
  // a plan or a question can only fail by being turned down, unless Claude Code says otherwise.
  const tagged = /^<tool_use_error>/.test(text);
  if (result.denied || (!tagged && (call.name === 'ExitPlanMode' || call.name === 'AskUserQuestion'))) {
    return { kind: 'denied', ...(text ? { note: text } : {}) };
  }
  return { kind: 'failed' };
}

export type Answer = { answer?: string; notes?: string };

/**
 * Your answers to Claude's questions, from the text Claude Code gave Claude for them:
 * `"question"="answer"` pairs, each maybe with ` notes: …`, in the order asked. The questions
 * are known, so an answer may hold quotes and commas.
 */
export function answersOf(questions: string[], text: string): Record<string, Answer> {
  const found = questions
    .map((question) => ({ question, at: text.indexOf(`"${question}"=`) }))
    .filter((f) => f.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out: Record<string, Answer> = {};
  found.forEach(({ question, at }, i) => {
    const next = found[i + 1];
    let part = text.slice(at + question.length + 3, next?.at);
    part = next ? part.replace(/,\s*$/, '') : part.replace(/\.(?: You can now continue[\s\S]*| Read the answers carefully[\s\S]*| They also wrote: [\s\S]*| Call [\s\S]*)?$/, '');
    let answer: string | undefined;
    if (part.startsWith('"')) {
      const ends = ['" selected preview:\n', '" notes: '].map((end) => part.indexOf(end)).filter((end) => end > 0);
      const end = ends.length > 0 ? Math.min(...ends) : part.lastIndexOf('"');
      answer = part.slice(1, end > 0 ? end : undefined);
      part = end > 0 ? part.slice(end + 1) : '';
    }
    const notes = part.match(/ notes: ([\s\S]*)$/)?.[1]?.trim();
    out[question] = { ...(answer ? { answer } : {}), ...(notes ? { notes } : {}) };
  });
  return out;
}

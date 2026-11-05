import { errorLine, nextStep } from '../../shared/errors';
import type { ChatMessage, ImageBlock, ToolResultBlock, TurnChanges } from '../../shared/protocol';
import { todosOf } from '../../shared/tasks';

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultBlock;
  /** A TodoWrite that only moves the same tasks along, which a line says better than the whole list again. */
  sameTasks?: true;
};

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
  }
  | { kind: 'compact'; key: string; summary: string }
  /** `saved`: the file Claude Code saved all of a long output in, by its name in the session's tool-results folder. */
  | { kind: 'shell'; key: string; command: string; stdout: string; stderr: string; saved?: string; timestamp?: number }
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

type Classified =
  | { kind: 'user'; text: string; images: ImageBlock[]; command?: { name: string; args: string } }
  | { kind: 'notice'; tone: 'output' | 'task' | 'interrupt' | 'info'; text: string; detail?: string }
  | { kind: 'shell'; command: string; stdout: string; stderr: string; saved?: string }
  /** The output of the `!` command just before, in a message of its own, as Claude Code writes it. */
  | { kind: 'shell-output'; stdout: string; stderr: string; saved?: string };

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
 * printed nothing is for Claude, and the card shows nothing in its place.
 */
function shellRecord(text: string): { stdout: string; stderr: string; saved?: string } {
  const stdout = shellOutput(tag(text, 'bash-stdout') ?? '');
  const stderr = shellOutput(tag(text, 'bash-stderr') ?? '');
  const saved = stdout.saved ?? stderr.saved;
  return { stdout: stdout.text === '(Bash completed with no output)' ? '' : stdout.text, stderr: stderr.text, ...(saved ? { saved } : {}) };
}

/** Splits what Claude Code wraps in tags out of a user message's text. */
function classifyUserText(raw: string): Classified | undefined {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return undefined;
  if (text.includes('<local-command-caveat>')) return undefined;
  // A `!` command and its output (Claude Code's bash mode), from any client.
  const bash = tag(text, 'bash-input');
  if (bash !== undefined) return { kind: 'shell', command: unescape(bash), ...shellRecord(text) };
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return { kind: 'shell-output', ...shellRecord(text) };
  const commandName = tag(text, 'command-name');
  if (commandName) {
    return { kind: 'user', text: '', images: [], command: { name: commandName, args: tag(text, 'command-args') ?? '' } };
  }
  const stdout = tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr');
  if (stdout !== undefined) {
    const clean = cleanOutput(stdout).trim();
    return clean ? { kind: 'notice', tone: 'output', text: clean } : undefined;
  }
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary') ?? 'Background task update';
    const result = tag(text, 'result');
    return { kind: 'notice', tone: 'task', text: summary, ...(result ? { detail: result } : {}) };
  }
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
  let tasks: { names: string; done: boolean } | undefined;

  const push = (item: Item, timestamp?: number) => {
    if (timestamp && item.kind === 'user') {
      const day = dayOf(timestamp);
      if (lastDay && day !== lastDay) items.push({ kind: 'day', key: `day-${item.key}`, timestamp });
      lastDay = day;
    } else if (timestamp && !lastDay) {
      lastDay = dayOf(timestamp);
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
    if (message.meta) continue;
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
      const classified: Classified | undefined = texts.length > 0 ? classifyUserText(texts.join('\n\n')) : { kind: 'user', text: '', images: [] };
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
        }
      } else {
        push({ ...classified, key: message.uuid });
        // Claude's answer to a background task's note comes after the note, as a turn of its own.
        if (classified.kind === 'notice' && classified.tone === 'task') turn = undefined;
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
        let sameTasks = false;
        if (block.name === 'TodoWrite') {
          // The list shows in full when it is new, its tasks change, or the last one is done;
          // an update that only moves along the same tasks shows as one line.
          const todos = todosOf(block.input);
          const next = { names: JSON.stringify(todos.map((t) => t.content)), done: todos.length > 0 && todos.every((t) => t.status === 'completed') };
          sameTasks = next.names === tasks?.names && !(next.done && !tasks.done);
          tasks = next;
        }
        turn!.parts.push({ kind: 'tool', key, call: { id: block.id, name: block.name, input: block.input, ...(result ? { result } : {}), ...(sameTasks ? { sameTasks: true } : {}) } });
      }
    });
  }
  return items;
}

/**
 * Where each turn's "files changed" goes: under the last of Claude's answers in it. Turns end
 * where Claude Code's /diff ends them (see changes.ts), at the next row it counts as a prompt: a
 * prompt with words or a `/` command, a `!` command, a background task's note, an interruption, a
 * compaction. A `/` command's output belongs to it, and a picture sent without words is no new turn.
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
    const starts = item.kind === 'user' ? !item.steered && (Boolean(item.text) || Boolean(item.command))
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

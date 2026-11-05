import type { ChatMessage, ImageBlock, ToolResultBlock } from '../../shared/protocol';

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultBlock;
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
  | { kind: 'notice'; key: string; tone: 'output' | 'task' | 'interrupt' | 'info'; text: string; detail?: string }
  | { kind: 'compact'; key: string; summary: string }
  | { kind: 'shell'; key: string; command: string; stdout: string; stderr: string; timestamp?: number }
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
  | { kind: 'shell'; command: string; stdout: string; stderr: string };

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

/** Splits what Claude Code wraps in tags out of a user message's text. */
function classifyUserText(raw: string): Classified | undefined {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return undefined;
  if (text.includes('<local-command-caveat>')) return undefined;
  // A `!` command and its output (Claude Code's bash mode), from any client.
  const bash = tag(text, 'bash-input');
  if (bash !== undefined) {
    return { kind: 'shell', command: unescape(bash), stdout: unescape(tag(text, 'bash-stdout') ?? ''), stderr: unescape(tag(text, 'bash-stderr') ?? '') };
  }
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return undefined;
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

/** Groups a conversation into what the chat shows: prompts, Claude's turns, and notices. */
export function buildItems(messages: ChatMessage[]): Item[] {
  const results = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    for (const block of message.blocks) if (block.type === 'tool_result') results.set(block.tool_use_id, block);
  }

  const items: Item[] = [];
  let turn: Extract<Item, { kind: 'assistant' }> | undefined;
  let lastDay: string | undefined;

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
        turn = undefined;
      } else {
        push({ ...classified, key: message.uuid });
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
        turn!.parts.push({ kind: 'tool', key, call: { id: block.id, name: block.name, input: block.input, ...(result ? { result } : {}) } });
      }
    });
  }
  return items;
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

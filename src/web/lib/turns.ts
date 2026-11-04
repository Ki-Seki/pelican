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

export type Item =
  | {
    kind: 'user';
    key: string;
    text: string;
    images: ImageBlock[];
    command?: { name: string; args: string };
    timestamp?: number;
    pending?: boolean;
  }
  | { kind: 'assistant'; key: string; parts: Part[]; timestamp?: number; model?: string }
  | { kind: 'notice'; key: string; tone: 'output' | 'task' | 'interrupt' | 'info'; text: string; detail?: string }
  | { kind: 'compact'; key: string; summary: string }
  | { kind: 'day'; key: string; timestamp: number };

const tag = (text: string, name: string) => {
  const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match?.[1]?.trim();
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

type Classified =
  | { kind: 'user'; text: string; images: ImageBlock[]; command?: { name: string; args: string } }
  | { kind: 'notice'; tone: 'output' | 'task' | 'interrupt' | 'info'; text: string; detail?: string };

/** Splits what Claude Code wraps in tags out of a user message's text. */
function classifyUserText(raw: string): Classified | undefined {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return undefined;
  if (text.includes('<local-command-caveat>')) return undefined;
  const commandName = tag(text, 'command-name');
  if (commandName) {
    return { kind: 'user', text: '', images: [], command: { name: commandName, args: tag(text, 'command-args') ?? '' } };
  }
  const stdout = tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr');
  if (stdout !== undefined) {
    const clean = stripAnsi(stdout).trim();
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
          key: message.uuid,
          images,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          ...(message.pending ? { pending: true } : {}),
        }, message.timestamp);
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

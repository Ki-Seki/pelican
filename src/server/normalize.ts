import type { Block, ChatMessage, ImageBlock, TextBlock } from '../shared/protocol.js';

const MAX_TEXT = 60_000;
const MAX_RESULT_TEXT = 24_000;
const MAX_IMAGE_BASE64 = 2_500_000;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The start of a long text, as a copy: a slice would keep the whole text in memory, so a clipped
 * 500 KB tool result would still cost 500 KB in every cache that holds the message.
 */
const head = (text: string, max: number) => structuredClone(`${text.slice(0, max)}\n…`);

function clip(text: string, max: number): TextBlock {
  return text.length > max ? { type: 'text', text: head(text, max), truncated: true } : { type: 'text', text };
}

/** A tool call's input with its long texts cut (a Write carries the whole file); the page shows their start. */
function clipInput(input: Raw): Raw {
  let clipped: Raw | undefined;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length <= MAX_TEXT) continue;
    clipped ??= { ...input };
    clipped[key] = head(value, MAX_TEXT);
  }
  return clipped ?? input;
}

/**
 * Where a page loads the `n`th picture a message holds as data (see `storedImages`). With one, a
 * message carries addresses instead of the pictures; without, the pictures themselves (a message
 * streaming in, before the transcript has it).
 */
export type ImageAddress = (n: number) => string;

type Images = { address?: ImageAddress; n: number };

function image(raw: Raw, images: Images): ImageBlock | undefined {
  const source = raw.source;
  if (!isRecord(source)) return undefined;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const n = images.n;
    images.n += 1;
    if (images.address) return { type: 'image', source: { type: 'url', url: images.address(n) } };
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return source.data.length > MAX_IMAGE_BASE64
      ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: '' }, omitted: true }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: source.data } };
  }
  if (source.type === 'url' && typeof source.url === 'string') return { type: 'image', source: { type: 'url', url: source.url } };
  return undefined;
}

/**
 * The pictures a message's content holds as data, in the order `ImageAddress` numbers them: its
 * own, and those inside its tool results, as `toChatMessage` meets them.
 */
export function storedImages(content: unknown): Array<{ mediaType: string; data: string }> {
  const found: Array<{ mediaType: string; data: string }> = [];
  const take = (raw: unknown) => {
    if (!isRecord(raw) || raw.type !== 'image' || !isRecord(raw.source)) return;
    const { type, data, media_type: mediaType } = raw.source;
    if (type === 'base64' && typeof data === 'string') found.push({ mediaType: typeof mediaType === 'string' ? mediaType : 'image/png', data });
  };
  if (!Array.isArray(content)) return found;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') take(block);
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && Array.isArray(block.content)) block.content.forEach(take);
  }
  return found;
}

function resultContent(content: unknown, images: Images): { content: string | Array<TextBlock | ImageBlock>; truncated: boolean } {
  if (typeof content === 'string') {
    const clipped = clip(content, MAX_RESULT_TEXT);
    return { content: clipped.text, truncated: Boolean(clipped.truncated) };
  }
  if (!Array.isArray(content)) return { content: '', truncated: false };
  let truncated = false;
  const parts: Array<TextBlock | ImageBlock> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const clipped = clip(part.text, MAX_RESULT_TEXT);
      truncated ||= Boolean(clipped.truncated);
      parts.push(clipped);
    } else if (part.type === 'image') {
      const img = image(part, images);
      if (img) parts.push(img);
    }
  }
  return { content: parts, truncated };
}

function blocks(content: unknown, images: Images): Block[] {
  if (typeof content === 'string') return content ? [clip(content, MAX_TEXT)] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case 'text':
        if (typeof raw.text === 'string' && raw.text) out.push(clip(raw.text, MAX_TEXT));
        break;
      case 'thinking':
        if (typeof raw.thinking === 'string' && raw.thinking.trim()) out.push({ type: 'thinking', thinking: raw.thinking });
        break;
      case 'tool_use':
      case 'server_tool_use':
        if (typeof raw.id === 'string' && typeof raw.name === 'string') {
          out.push({ type: 'tool_use', id: raw.id, name: raw.name, input: isRecord(raw.input) ? clipInput(raw.input) : {} });
        }
        break;
      case 'tool_result': {
        if (typeof raw.tool_use_id !== 'string') break;
        const { content: resultBody, truncated } = resultContent(raw.content, images);
        out.push({
          type: 'tool_result',
          tool_use_id: raw.tool_use_id,
          content: resultBody,
          ...(raw.is_error === true ? { is_error: true } : {}),
          ...(truncated ? { truncated: true } : {}),
        });
        break;
      }
      case 'web_search_tool_result':
        if (typeof raw.tool_use_id === 'string') {
          const results = Array.isArray(raw.content) ? raw.content.filter(isRecord) : [];
          const text = results.map((r) => `${String(r.title ?? '')} ${String(r.url ?? '')}`.trim()).join('\n');
          out.push({ type: 'tool_result', tool_use_id: raw.tool_use_id, content: text });
        }
        break;
      case 'image': {
        const img = image(raw, images);
        if (img) out.push(img);
        break;
      }
      case 'document':
        out.push({ type: 'text', text: '[document]' });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Converts a transcript message (`getSessionMessages`) or a streamed SDK message
 * into the shape the app renders. Returns undefined for messages with nothing
 * to show. With `address`, pictures held as data are referred to by address.
 */
export function toChatMessage(raw: Raw, address?: ImageAddress): ChatMessage | undefined {
  const type = raw.type;
  if (type !== 'user' && type !== 'assistant') return undefined;
  if (typeof raw.uuid !== 'string') return undefined;
  const message = isRecord(raw.message) ? raw.message : {};
  const out: ChatMessage = {
    uuid: raw.uuid,
    role: type,
    blocks: blocks(message.content, { ...(address ? { address } : {}), n: 0 }),
  };
  if (out.blocks.length === 0) return undefined;
  const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  if (!Number.isNaN(timestamp)) out.timestamp = timestamp;
  const parent = raw.parent_tool_use_id;
  if (typeof parent === 'string') out.parentToolUseId = parent;
  if (type === 'assistant') {
    if (typeof message.model === 'string') out.model = message.model;
    if (typeof message.id === 'string') out.messageId = message.id;
    // Claude Code notes a failed API call as a reply of its own (in the stream: an `error` on a synthetic message).
    if (raw.isApiErrorMessage === true || (typeof raw.error === 'string' && message.model === '<synthetic>')) out.apiError = true;
  }
  // Text Claude Code adds itself (an image's scale note, skill text) is meta in the transcript
  // and synthetic in the live stream; either way it is not something you typed.
  if (raw.is_meta === true || raw.isMeta === true || raw.isSynthetic === true) out.meta = true;
  if (raw.isCompactSummary === true) out.compactSummary = true;
  return out;
}

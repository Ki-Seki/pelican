import path from 'node:path';

import type { AgentLaunch, Block, ChatMessage, DeliveredFile, Delivery, Handback, ImageBlock, TextBlock, ToolResultBlock, WorkflowLaunch } from '../shared/protocol.js';
import { RUN_ID } from '../shared/workflows.js';

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

/** `omit`: pictures held as data are left out (a page that has no address to load them from). */
type Images = { address?: ImageAddress; omit?: boolean; n: number };

function image(raw: Raw, images: Images): ImageBlock | undefined {
  const source = raw.source;
  if (!isRecord(source)) return undefined;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const n = images.n;
    images.n += 1;
    if (images.address) return { type: 'image', source: { type: 'url', url: images.address(n) } };
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    if (images.omit) return { type: 'image', source: { type: 'base64', media_type: mediaType, data: '' }, omitted: true };
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
 * What a Workflow call launched, from what Claude Code records of its result (`toolUseResult` in a
 * transcript, `tool_use_result` in the stream): the run its agents write to, and its task.
 */
function workflowLaunch(output: Raw): WorkflowLaunch | undefined {
  const text = (value: unknown, max = 2000) => (typeof value === 'string' && value && value.length <= max ? value : undefined);
  const runId = text(output.runId, 80);
  const name = text(output.workflowName, 200);
  if (output.taskType !== 'local_workflow' && !(runId && RUN_ID.test(runId)) && !name) return undefined;
  const taskId = text(output.taskId, 80);
  const summary = text(output.summary);
  const sessionUrl = text(output.sessionUrl);
  const scriptFile = text(output.scriptPath)?.split(/[\\/]/).pop();
  return {
    ...(runId && RUN_ID.test(runId) ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    ...(sessionUrl && /^https:\/\//.test(sessionUrl) ? { sessionUrl } : {}),
    ...(scriptFile && /^[\w.-]{1,200}\.js$/.test(scriptFile) ? { scriptFile } : {}),
  };
}

/** A subagent's id, as Claude Code names its transcript and its task (`agent-<id>.jsonl`). */
const AGENT = /^[\w-]{1,80}$/;

/**
 * What an Agent call that does not wait for its agent began, from what Claude Code records of its
 * result: an agent in the background here (`async_launched`), one in a cloud session
 * (`remote_launched`), or a teammate (`teammate_spawned`). The text Claude Code gives Claude for it
 * is for the model alone; what a page shows of it comes from here.
 */
function agentLaunch(output: Raw): AgentLaunch | undefined {
  const id = (value: unknown) => (typeof value === 'string' && AGENT.test(value) ? value : undefined);
  // A Workflow call's launch says which kind of task it registered; an Agent call's does not.
  if (output.taskType !== undefined) return undefined;
  if (output.status === 'async_launched' && id(output.agentId)) return { mode: 'background', agentId: id(output.agentId)! };
  if (output.status === 'remote_launched') {
    const url = typeof output.sessionUrl === 'string' && output.sessionUrl.length <= 2000 && /^https:\/\//.test(output.sessionUrl) ? output.sessionUrl : undefined;
    return { mode: 'cloud', ...(url ? { sessionUrl: url } : {}) };
  }
  if (output.status === 'teammate_spawned') {
    const agentId = id(output.agent_id) ?? id(output.agentId);
    const name = typeof output.name === 'string' && output.name.trim() ? output.name.trim().slice(0, 64) : undefined;
    return { mode: 'teammate', ...(agentId ? { agentId } : {}), ...(name ? { name } : {}) };
  }
  return undefined;
}

/** Where the frame Claude Code puts around a handed-back report ends, and the report, each line of it indented, begins. */
const FRAME = '[Subagent hand-back]';
const FOLLOWS = 'The report follows:\n';

/** The report inside Claude Code's hand-back frame, its lines as the subagent wrote them: undefined if there is no frame. */
function framedReport(text: string): string | undefined {
  const frame = text.indexOf(FRAME);
  const start = frame < 0 ? -1 : text.indexOf(FOLLOWS, frame);
  if (start < 0) return undefined;
  const rest = text.slice(start + FOLLOWS.length);
  const end = rest.lastIndexOf('\n</agent-message>');
  return (end < 0 ? rest : rest.slice(0, end)).split('\n').map((line) => (line.startsWith('  ') ? line.slice(2) : line.trimStart())).join('\n').trimEnd();
}

/**
 * A subagent's final report, handed back to its session (its SubagentHandback call): Claude Code
 * delivers it as a message of its own, from that agent, marked as one (`origin`), framed for the
 * model. Which agent, and the report as the agent wrote it: Claude Code's copy of it where it keeps
 * one, else read out of the frame.
 */
export function handbackOf(raw: Raw, text: string): Handback | undefined {
  const origin = isRecord(raw.origin) ? raw.origin : undefined;
  if (origin?.kind !== 'peer') return undefined;
  const body = typeof origin.body === 'string' ? origin.body : '';
  if (origin.handback !== true && !body.includes(FRAME) && !text.includes(FRAME)) return undefined;
  const from = [origin.senderTaskId, origin.from].find((value): value is string => typeof value === 'string' && AGENT.test(value));
  const report = typeof origin.handbackReportText === 'string' ? origin.handbackReportText : framedReport(body) ?? framedReport(text);
  if (!from || !report?.trim()) return undefined;
  return { from, report: report.length > MAX_TEXT ? head(report, MAX_TEXT) : report };
}

/** Longer than any path a file system takes: a "path" past it is not one. */
const MAX_PATH = 4096;
const MEDIA_TYPE = /^[\w.+-]{1,60}\/[\w.+-]{1,100}$/;

/**
 * What a SendUserFile call delivered, from what Claude Code records of its result (`toolUseResult`
 * in a transcript, `tool_use_result` in the stream): each file by the absolute path Claude Code
 * checked it at. A file it says it did not deliver (`upload_error`: a path that came to lead
 * somewhere not approved, or a viewer it could not reach), or did not check as a path on this
 * computer, is only counted, so nothing shows it.
 */
export function deliveryOf(output: Raw): Delivery | undefined {
  const list = output.attachments;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const files: DeliveredFile[] = [];
  let missed = 0;
  for (const item of list) {
    const file = isRecord(item) ? item.path : undefined;
    const checked = isRecord(item) && item.upload_error === undefined && item.pathValidated !== false;
    if (!checked || typeof file !== 'string' || !file || file.length > MAX_PATH || file.includes('\0') || !path.isAbsolute(file)) {
      missed += 1;
      continue;
    }
    files.push({
      path: file,
      ...(typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0 ? { size: item.size } : {}),
      ...(item.isImage === true ? { image: true } : {}),
      ...(typeof item.media_type === 'string' && MEDIA_TYPE.test(item.media_type) ? { type: item.media_type } : {}),
    });
  }
  const display = output.display === 'render' || output.display === 'attach' ? output.display : undefined;
  const caption = typeof output.caption === 'string' && output.caption.trim() ? output.caption.slice(0, 2000) : undefined;
  return { files, ...(display ? { display } : {}), ...(caption ? { caption } : {}), ...(missed > 0 ? { missed } : {}) };
}

/**
 * Converts a transcript message (`getSessionMessages`) or a streamed SDK message
 * into the shape the app renders. Returns undefined for messages with nothing
 * to show. With `address`, pictures held as data are referred to by address; with `omit`, they are
 * left out.
 */
export function toChatMessage(raw: Raw, address?: ImageAddress | 'omit'): ChatMessage | undefined {
  const type = raw.type;
  if (type !== 'user' && type !== 'assistant') return undefined;
  if (typeof raw.uuid !== 'string') return undefined;
  const message = isRecord(raw.message) ? raw.message : {};
  const out: ChatMessage = {
    uuid: raw.uuid,
    role: type,
    blocks: blocks(message.content, { ...(address === 'omit' ? { omit: true } : address ? { address } : {}), n: 0 }),
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
    if (raw.isApiErrorMessage === true || (typeof raw.error === 'string' && message.model === '<synthetic>')) {
      out.apiError = true;
      if (typeof raw.error === 'string') out.error = raw.error;
    }
  }
  // Text Claude Code adds itself (an image's scale note, skill text) is meta in the transcript
  // and synthetic in the live stream; either way it is not something you typed.
  if (raw.is_meta === true || raw.isMeta === true || raw.isSynthetic === true) out.meta = true;
  // A subagent's report handed back is Claude Code's message to the model, not one you typed: its
  // agent's card shows the report.
  if (type === 'user') {
    const handback = handbackOf(raw, out.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    if (handback) {
      out.handback = handback;
      out.meta = true;
    }
  }
  if (raw.isCompactSummary === true) out.compactSummary = true;
  // A `!` command's output row is read by the Claude Code that wrote it (ChatMessage.version).
  if (type === 'user' && typeof raw.version === 'string' && raw.version.length <= 32 && out.blocks.some((b) => b.type === 'text' && /^\s*<bash-std(?:out|err)>/.test(b.text))) out.version = raw.version;
  // Claude Code marks the row that answers a refused call; its text alone may be just the user's note.
  if (typeof raw.toolDenialKind === 'string' && raw.toolDenialKind !== 'interrupted') {
    for (const block of out.blocks) if (block.type === 'tool_result') block.denied = true;
  }
  // What Claude Code records of a tool's result belongs to the one result the row holds.
  const output = isRecord(raw.toolUseResult) ? raw.toolUseResult : isRecord(raw.tool_use_result) ? raw.tool_use_result : undefined;
  const results = output ? out.blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
  const only = results.length === 1 ? results[0] : undefined;
  if (output && only) {
    const launch = workflowLaunch(output);
    if (launch) only.workflow = launch;
    const delivered = only.is_error ? undefined : deliveryOf(output);
    if (delivered) only.delivered = delivered;
    const agent = only.is_error ? undefined : agentLaunch(output);
    if (agent) only.agent = agent;
  }
  return out;
}

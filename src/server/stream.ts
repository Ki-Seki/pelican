import type { PartialAppend, PartialBlock, RunState, ServerEvent } from '../shared/protocol.js';

/**
 * How much of a tool call's input streams to the page: enough for the fields that name the call
 * (path, command, pattern, address), never the file being written.
 */
export const PARTIAL_INPUT_MAX = 2048;

const textOf = (block: PartialBlock) => (block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : block.inputJson);

/**
 * A block as the page gets it, always a copy: the run adds each piece of text to its blocks in
 * place, so a block kept as it was sent would grow with them and show nothing to append.
 */
export const shown = (block: PartialBlock): PartialBlock =>
  (block.type === 'tool_use' && block.inputJson.length > PARTIAL_INPUT_MAX ? { ...block, inputJson: block.inputJson.slice(0, PARTIAL_INPUT_MAX) } : { ...block });

const restOf = new WeakMap<RunState, string>();

/** The state without its streamed blocks, as text; worked out once per state, however many clients watch. */
function rest(state: RunState): string {
  let text = restOf.get(state);
  if (text === undefined) {
    const { partial: _partial, ...others } = state;
    text = JSON.stringify(others);
    restOf.set(state, text);
  }
  return text;
}

/** What `after` adds to `before` at the ends of its blocks, or undefined when it changes more than that. */
function appendsTo(before: PartialBlock[], after: PartialBlock[]): PartialAppend[] | undefined {
  if (before.length !== after.length) return undefined;
  const appends: PartialAppend[] = [];
  for (const [index, block] of after.entries()) {
    const old = before[index]!;
    if (old.type !== block.type || (old.type === 'tool_use' && block.type === 'tool_use' && old.name !== block.name)) return undefined;
    const from = textOf(old);
    const to = textOf(block);
    if (to.length < from.length || !to.startsWith(from)) return undefined;
    if (to.length > from.length) appends.push({ index, from: from.length, text: to.slice(from.length) });
  }
  return appends;
}

/**
 * One client's copy of one session's run. The run sends its whole state many times a second
 * while Claude writes; this turns each into what the client lacks: nothing when it has it, the
 * text added when only that grew, and the whole state otherwise (a block starts or ends, the
 * status or anything else changes). Data then grows with the answer, not with its square.
 */
export class RunChannel {
  private sent?: { rest: string; blocks: PartialBlock[] };

  constructor(readonly sessionId: string) {}

  /** The event that brings the client to `state`; undefined when it has it already. */
  next(state: RunState | null): ServerEvent | undefined {
    if (!state) {
      this.sent = undefined;
      return { type: 'run', sessionId: this.sessionId, state: null };
    }
    const blocks = state.partial.map(shown);
    const now = rest(state);
    const before = this.sent;
    this.sent = { rest: now, blocks };
    if (before && before.rest === now) {
      const appends = appendsTo(before.blocks, blocks);
      if (appends) return appends.length > 0 ? { type: 'partial', sessionId: this.sessionId, appends } : undefined;
    }
    return { type: 'run', sessionId: this.sessionId, state: { ...state, partial: blocks } };
  }

  /** The client may have missed something: it gets the whole state next. */
  reset(): void {
    this.sent = undefined;
  }
}

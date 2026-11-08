import { stat } from 'node:fs/promises';
import path from 'node:path';

import { type Hunk, unifiedDiff } from '../shared/line-diff.js';
import type { ChatMessage, SessionChanges, TurnChanges, TurnFile } from '../shared/protocol.js';
import { readHistory } from './history.js';
import { editedLines, type RecordedEdit, recordedEdit } from './normalize.js';
import { openRegular } from './open.js';

/**
 * What each turn of a session changed, as Claude Code's /diff shows it in its turn views: from
 * Claude's own file edits as the transcript records them (each Edit, MultiEdit and Write result
 * carries a structured patch, or a new file's text), not from git, so it works in any folder and
 * runs nothing. A change Claude made through a command shows only in git's views, as in the CLI;
 * so does a notebook's, which /diff's turns leave out too.
 *
 * Turns are cut and numbered as /diff cuts and numbers them: each row it counts as a prompt (a
 * typed one, a `/` or `!` command and their output, a background task's note, the summary a
 * compaction left) starts one, numbered by its place among them, and holds the edits that follow
 * it up to the next. So a prompt that changed nothing leaves a gap, and what Claude does in answer
 * to a `!` command is that command's turn. A turn's diff of a file is each of its edits' patches
 * in turn, and its counts their lines added up, as in /diff, and as Claude Desktop adds up a turn's
 * steps, each step counting its own (ToolResultBlock's `edited`, from the same patch): so the line
 * under a turn says what its steps say. A new file's lines are counted as Desktop counts them
 * (normalize.ts, recordedEdit), not as /diff does, one more where the file ends in a newline.
 *
 * The transcript is read the way history.ts reads it: incrementally, parsing only the rows that
 * matter here (edit results, checkpoints and prompts); an edit's patch is read again from its row
 * when a diff is asked for, so what is kept per edit is a few numbers.
 */

/** One file one tool call changed. */
type FileEdit = { path: string; added: number; removed: number; line?: number; created?: boolean };
type EditRow = { at: number; bytes: number; toolUseId?: string; edits: FileEdit[] };

type Scan = {
  ino: number;
  offset: number;
  carry: Buffer;
  rows: Map<string, EditRow>;
  /** The prompts Claude Code kept the files for (file-history snapshots), by the prompt's id. */
  checkpoints: Set<string>;
  /** Rows copied from another session (a side chat's, a fork's), which ran there, not here. */
  copied: Set<string>;
  readAt: number;
};

const CHUNK = 8 * 1024 * 1024;
const KEEP = 8;
const KEEP_UNREAD_MS = 10 * 60_000;
const scans = new Map<string, Scan>();
const locks = new Map<string, Promise<unknown>>();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Where the first change of a patch is, in the file as it left it. */
function firstLine(hunks: readonly Hunk[]): number | undefined {
  const hunk = hunks[0];
  if (!hunk) return undefined;
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    if (text.startsWith('+') || text.startsWith('-')) return Math.max(1, line);
    if (text.startsWith(' ')) line += 1;
  }
  return Math.max(1, hunk.newStart);
}

/** What Claude Code writes into a user row that nobody typed: command output, `!` commands, notes. */
const NOT_TYPED = /^\s*(?:<(?:bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder)>|\[Request interrupted)/;
const isPrompt = (text: string) => Boolean(text.trim()) && !NOT_TYPED.test(text);

function empty(ino: number): Scan {
  return { ino, offset: 0, carry: Buffer.alloc(0), rows: new Map(), checkpoints: new Set(), copied: new Set(), readAt: Date.now() };
}

/** The relative path of a file inside `cwd`, or the path as it is. */
const relative = (file: string, cwd: string | undefined) => (cwd && file.startsWith(`${cwd}${path.sep}`) ? file.slice(cwd.length + 1) : file);

function addRow(scan: Scan, line: string, at: number, bytes: number, cwd: string | undefined, own: string): void {
  if (line.length < 2 || line.charCodeAt(0) !== 123) return;
  const snapshot = line.includes('"file-history-snapshot"');
  const result = line.includes('"toolUseResult"');
  // A prompt: a user row with no tool result in it (those carry "tool_use_id").
  const prompt = !result && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
  if (!snapshot && !result && !prompt) return;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (row.type === 'file-history-snapshot') {
    const id = str(row.messageId) ?? str(isRecord(row.snapshot) ? row.snapshot.messageId : undefined);
    if (id) scan.checkpoints.add(id);
    return;
  }
  const uuid = str(row.uuid);
  if (!uuid || row.isSidechain === true) return;
  // Copied as Claude Code's forkSession copies (it says from where), or as Claude Desktop's side
  // chats carry their session's rows (under its id).
  if ((row.forkedFrom !== undefined && row.forkedFrom !== null) || (typeof row.sessionId === 'string' && row.sessionId !== own)) scan.copied.add(uuid);
  const edit = result ? recordedEdit(row.toolUseResult) : undefined;
  if (!edit) return;
  const content = isRecord(row.message) && Array.isArray(row.message.content) ? row.message.content : [];
  const toolUseId = content.map((b) => (isRecord(b) ? str(b.tool_use_id) : undefined)).find(Boolean);
  const line1 = firstLine(edit.hunks);
  scan.rows.set(uuid, {
    at,
    bytes,
    ...(toolUseId ? { toolUseId } : {}),
    edits: [{ path: relative(edit.file, cwd), ...editedLines(edit.hunks), ...(line1 ? { line: line1 } : {}), ...(edit.created ? { created: true } : {}) }],
  });
}

async function readNew(file: string, scan: Scan, size: number, cwd: string | undefined): Promise<void> {
  const own = path.basename(file, '.jsonl');
  const handle = await openRegular(file);
  try {
    while (scan.offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - scan.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, scan.offset);
      if (bytesRead <= 0) break;
      const data = scan.carry.length > 0 ? Buffer.concat([scan.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const start = scan.offset - scan.carry.length;
      const lastBreak = data.lastIndexOf(0x0a);
      scan.offset += bytesRead;
      if (lastBreak < 0) {
        scan.carry = Buffer.from(data);
        continue;
      }
      scan.carry = Buffer.from(data.subarray(lastBreak + 1));
      for (let from = 0; from <= lastBreak;) {
        const end = data.indexOf(0x0a, from);
        addRow(scan, data.toString('utf8', from, end), start + from, end - from, cwd, own);
        from = end + 1;
      }
    }
  } finally {
    await handle.close();
  }
}

/** The transcript scanned up to its end, one read of a file at a time. */
async function scanned(file: string, cwd: string | undefined): Promise<Scan> {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const info = await stat(file);
    let scan = scans.get(file);
    if (!scan || scan.ino !== info.ino || info.size < scan.offset) scan = empty(info.ino);
    scans.delete(file);
    scans.set(file, scan);
    scan.readAt = Date.now();
    if (info.size > scan.offset) await readNew(file, scan, info.size, cwd);
    for (const [other, kept] of scans) {
      if (scans.size <= KEEP && Date.now() - kept.readAt < KEEP_UNREAD_MS) break;
      if (other !== file) scans.delete(other);
    }
    return scan;
  });
  locks.set(file, next);
  void next.finally(() => {
    if (locks.get(file) === next) locks.delete(file);
  }).catch(() => undefined);
  return next;
}

/**
 * Whether Claude Code's /diff counts a message as a prompt, starting a turn there and numbering it
 * by it (its diff panel's own test): a user row with text in it and no tool result, not one Claude
 * Code added itself. A `!` command and its output, a `/` command and its output, a background
 * task's note and the summary a compaction left count; a picture sent without words does not.
 */
function countsAsPrompt(message: ChatMessage): boolean {
  return message.role === 'user' && !message.meta && !message.steered && !message.parentToolUseId
    && !message.blocks.some((b) => b.type === 'tool_result') && message.blocks.some((b) => b.type === 'text' && b.text !== '');
}

const words = (text: string) => text.replace(/\s+/g, ' ').trim();
const tagged = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];

/**
 * A turn's name, from the row that starts it, in the words the conversation shows for that row: a
 * prompt's words, a command as it was typed (`/review the theme`, `!npm test`), a background
 * task's note.
 */
function nameOf(message: ChatMessage, text: string): string {
  if (message.compactSummary) return 'Context compacted';
  const command = tagged(text, 'command-name');
  if (command) return words(`${command} ${tagged(text, 'command-args') ?? ''}`);
  if (isPrompt(text)) {
    const typed = words(text.replace(/(?:^|\n\n)Attached files:\n[\s\S]*$/, ''));
    if (typed) return typed;
    const files = [...text.matchAll(/^- .+ \((.+)\)$/gm)].map((m) => m[1]);
    return files.length > 0 ? files.join(', ') : 'Attached files';
  }
  const bash = tagged(text, 'bash-input');
  if (bash !== undefined) return `!${bash.trim()}`;
  if (/^\s*<task-notification>/.test(text)) return words(tagged(text, 'summary') ?? '') || 'Background task update';
  if (/^\s*\[Request interrupted/.test(text)) return 'Interrupted';
  if (/^\s*<(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/.test(text)) return 'Command output';
  return 'Claude Code';
}

/** What a row is to the turn it may start: a command whose output row comes next, or that output. */
function partOf(text: string): 'bash' | 'bash-output' | 'command' | 'command-output' | undefined {
  if (/^\s*<bash-input>/.test(text)) return 'bash';
  if (/^\s*<(?:bash-stdout|bash-stderr)>/.test(text)) return 'bash-output';
  if (/<command-name>/.test(text) && !NOT_TYPED.test(text)) return 'command';
  if (/^\s*<(?:local-command-stdout|local-command-stderr)>/.test(text)) return 'command-output';
  return undefined;
}

type Turn = { uuid: string; n: number; text: string; at?: number; rows: Array<{ uuid: string; row: EditRow }>; awaits?: 'bash-output' | 'command-output' };

/**
 * The conversation as it stands (its current branch), cut into turns where /diff cuts it: at each
 * row it counts as a prompt (countsAsPrompt), numbered by that row's place among them, each with
 * the edit rows up to the next. A command and its output are two such rows, and /diff gives what
 * Claude does in answer to the output the output's number; here that turn is the command's, named
 * and kept (for Rewind) by the row that holds the command. /diff sees only what followed the last
 * compaction and numbers from its summary; here, where the turns before it show too, the count
 * runs on through it. `ownOnly`: without the rows copied from another session (a side chat's).
 */
function turnsOf(messages: readonly ChatMessage[], scan: Scan, ownOnly: boolean): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  let place = 0;
  for (const message of messages) {
    if (ownOnly && scan.copied.has(message.uuid)) continue;
    if (countsAsPrompt(message)) {
      place += 1;
      // As the conversation shows the row: without the notes Claude Code puts in it for Claude.
      const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      const part = partOf(text);
      if (turn && part && turn.awaits === part && turn.rows.length === 0) {
        // The output of the command just before: the turn Claude answers it in, the command's.
        turn.n = place;
        delete turn.awaits;
        continue;
      }
      turn = {
        uuid: message.uuid,
        n: place,
        text: nameOf(message, text),
        ...(message.timestamp ? { at: message.timestamp } : {}),
        rows: [],
        ...(part === 'bash' ? { awaits: 'bash-output' as const } : part === 'command' ? { awaits: 'command-output' as const } : {}),
      };
      turns.push(turn);
      continue;
    }
    const row = scan.rows.get(message.uuid);
    if (row && turn) turn.rows.push({ uuid: message.uuid, row });
  }
  return turns.filter((t) => t.rows.length > 0);
}

/** A turn's files, in the order Claude first edited them, each with its edits' lines added up, as /diff counts them. */
function filesOf(turn: Turn): TurnFile[] {
  const byPath = new Map<string, FileEdit[]>();
  for (const { row } of turn.rows) {
    for (const edit of row.edits) byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
  }
  return [...byPath].map(([file, edits]) => {
    const first = edits[0]!;
    const added = edits.reduce((sum, e) => sum + e.added, 0);
    const removed = edits.reduce((sum, e) => sum + e.removed, 0);
    return { path: file, added, removed, ...(first.created ? { created: true } : {}), ...(first.line ? { line: first.line } : {}) };
  });
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * What each turn of the session in `file` changed, oldest first. `cwd`: the session's folder, for
 * relative paths; `ownOnly`: a side chat's, which leaves out the turns it copied of its session;
 * `rewoundTo`: the prompt its conversation was rewound to before (rewound.ts), whose turn and those
 * after it are left out until the next message.
 */
export async function sessionChanges(file: string, cwd: string | undefined, ownOnly = false, rewoundTo?: string): Promise<SessionChanges> {
  const scan = await scanned(file, cwd);
  // Rewound: the turns before the prompt the conversation went back to before, until the next message.
  const messages = await readHistory(file);
  const cut = rewoundTo ? messages.findIndex((m) => m.uuid === rewoundTo) : -1;
  const turns: TurnChanges[] = turnsOf(cut < 0 ? messages : messages.slice(0, cut), scan, ownOnly).map((turn) => ({
    uuid: turn.uuid,
    n: turn.n,
    text: clip(turn.text, 120),
    ...(turn.at ? { at: turn.at } : {}),
    files: filesOf(turn),
    checkpoint: scan.checkpoints.has(turn.uuid),
  }));
  const lines: Record<string, number> = {};
  for (const [uuid, row] of scan.rows) {
    const line = row.edits[0]?.line;
    if (row.toolUseId && line && !(ownOnly && scan.copied.has(uuid))) lines[row.toolUseId] = line;
  }
  return { turns, lines };
}

/** The edit a row recorded, read again from its place in the file. */
async function readEdit(file: string, row: EditRow): Promise<RecordedEdit | undefined> {
  const handle = await openRegular(file);
  try {
    const buffer = Buffer.alloc(row.bytes);
    await handle.read(buffer, 0, row.bytes, row.at);
    const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
    return recordedEdit(parsed.toolUseResult);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Past this many edits of one file in one turn, only the first ones are shown. */
const MAX_EDITS_SHOWN = 50;

/**
 * What one turn changed in one file, as Claude Code's /diff shows it: each edit's patch, in the
 * order Claude made them; a new file with nothing in it, as git's header says one. Empty when the
 * turn did not edit the file.
 */
export async function turnDiff(file: string, cwd: string | undefined, turnId: string, target: string, ownOnly = false): Promise<string> {
  const scan = await scanned(file, cwd);
  const turn = turnsOf(await readHistory(file), scan, ownOnly).find((t) => t.uuid === turnId);
  const rows = (turn?.rows ?? []).filter(({ row }) => row.edits.some((e) => e.path === target)).map(({ row }) => row);
  if (rows.length === 0) return '';
  const edits = await Promise.all(rows.slice(0, MAX_EDITS_SHOWN).map((row) => readEdit(file, row)));
  const diff = unifiedDiff(target, edits.flatMap((edit) => edit?.hunks ?? []))
    || (edits.some((edit) => edit?.created) ? `diff --git a/${target} b/${target}\nnew file mode 100644\n` : '');
  return rows.length > MAX_EDITS_SHOWN ? `${diff}… (${rows.length - MAX_EDITS_SHOWN} more edits of this file in this turn)\n` : diff;
}

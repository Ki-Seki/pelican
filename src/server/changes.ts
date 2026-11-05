import { stat } from 'node:fs/promises';
import path from 'node:path';

import { type Hunk, lineDiff, splitLines, toHunks, unifiedDiff } from '../shared/line-diff.js';
import type { ChatMessage, SessionChanges, TurnChanges, TurnFile } from '../shared/protocol.js';
import { readHistory } from './history.js';
import { openRegular } from './open.js';

/**
 * What each turn of a session changed, as Claude Code's /diff shows it in its turn views: from
 * Claude's own file edits as the transcript records them (each Edit, MultiEdit, Write and
 * NotebookEdit result carries a structured patch), not from git, so it works in any folder and
 * runs nothing. A change Claude made through a command shows only in git's views, as in the CLI.
 * Turns are the prompts that led Claude to edit files, numbered as /diff numbers them: by the
 * prompt's place among the conversation's prompts, so one that changed nothing leaves a gap. A
 * turn's diff of a file is each of its edits' patches in turn, and its counts their lines added
 * up, as in /diff.
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
  readAt: number;
};

const CHUNK = 8 * 1024 * 1024;
const KEEP = 8;
const KEEP_UNREAD_MS = 10 * 60_000;
const scans = new Map<string, Scan>();
const locks = new Map<string, Promise<unknown>>();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** What one tool result says it did to one file. */
type Recorded = { file: string; hunks: Hunk[]; created: boolean };

function hunksOf(value: unknown): Hunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: Hunk[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.lines)) return undefined;
    const numbers = [raw.oldStart, raw.oldLines, raw.newStart, raw.newLines];
    if (!numbers.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return undefined;
    hunks.push({ oldStart: raw.oldStart as number, oldLines: raw.oldLines as number, newStart: raw.newStart as number, newLines: raw.newLines as number, lines: raw.lines.filter((l): l is string => typeof l === 'string') });
  }
  return hunks;
}

/**
 * The file edit a tool result records (`toolUseResult` on its row), in Claude Code's shapes: Edit
 * and MultiEdit (a patch and the file before it), Write (a new file's text, or a patch), and
 * NotebookEdit (a cell's source before and after). Edits held for review (`staged`) changed
 * nothing; anything else is not an edit.
 */
export function recordedEdit(result: unknown): Recorded | undefined {
  if (!isRecord(result) || result.staged === true) return undefined;
  const notebook = str(result.notebook_path);
  if (notebook) {
    if (typeof result.new_source !== 'string' || str(result.error)) return undefined;
    const ops = lineDiff(splitLines(str(result.old_source) ?? ''), splitLines(result.edit_mode === 'delete' ? '' : result.new_source));
    return ops ? { file: notebook, hunks: toHunks(ops), created: false } : undefined;
  }
  const file = str(result.filePath);
  if (!file) return undefined;
  if (result.type === 'create' && typeof result.content === 'string') {
    const ops = lineDiff([], splitLines(result.content));
    return { file, hunks: ops ? toHunks(ops) : [], created: true };
  }
  const hunks = hunksOf(result.structuredPatch);
  return hunks ? { file, hunks, created: false } : undefined;
}

function counts(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

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
  return { ino, offset: 0, carry: Buffer.alloc(0), rows: new Map(), checkpoints: new Set(), readAt: Date.now() };
}

/** The relative path of a file inside `cwd`, or the path as it is. */
const relative = (file: string, cwd: string | undefined) => (cwd && file.startsWith(`${cwd}${path.sep}`) ? file.slice(cwd.length + 1) : file);

function addRow(scan: Scan, line: string, at: number, bytes: number, cwd: string | undefined): void {
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
  const edit = result ? recordedEdit(row.toolUseResult) : undefined;
  if (!edit) return;
  const content = isRecord(row.message) && Array.isArray(row.message.content) ? row.message.content : [];
  const toolUseId = content.map((b) => (isRecord(b) ? str(b.tool_use_id) : undefined)).find(Boolean);
  const line1 = firstLine(edit.hunks);
  scan.rows.set(uuid, {
    at,
    bytes,
    ...(toolUseId ? { toolUseId } : {}),
    edits: [{ path: relative(edit.file, cwd), ...counts(edit.hunks), ...(line1 ? { line: line1 } : {}), ...(edit.created ? { created: true } : {}) }],
  });
}

async function readNew(file: string, scan: Scan, size: number, cwd: string | undefined): Promise<void> {
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
        addRow(scan, data.toString('utf8', from, end), start + from, end - from, cwd);
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

/** Whether a message of the conversation is a prompt someone typed or a command they ran. */
function promptOf(message: ChatMessage): string | undefined {
  if (message.role !== 'user' || message.meta || message.compactSummary || message.steered || message.parentToolUseId) return undefined;
  if (message.blocks.some((b) => b.type === 'tool_result')) return undefined;
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const images = message.blocks.some((b) => b.type === 'image');
  if (!isPrompt(text) && !images) return undefined;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1];
  const words = command ? `${command} ${args ?? ''}` : text.replace(/(?:^|\n\n)Attached files:\n[\s\S]*$/, '');
  return words.replace(/\s+/g, ' ').trim() || (images ? 'An image' : '');
}

/**
 * Whether Claude Code's /diff counts a message as a prompt, numbering turns by it (its diff
 * panel's own test): a user row with text in it and no tool result, not one Claude Code added
 * itself. A `!` command, its output, a `/` command and its output count, and so does the summary
 * a compaction left.
 */
function countsAsPrompt(message: ChatMessage): boolean {
  return message.role === 'user' && !message.meta && !message.steered && !message.parentToolUseId
    && !message.blocks.some((b) => b.type === 'tool_result') && message.blocks.some((b) => b.type === 'text' && b.text !== '');
}

type Turn = { uuid: string; n: number; text: string; at?: number; rows: Array<{ uuid: string; row: EditRow }> };

/**
 * The conversation as it stands (its current branch), cut into prompts with the edit rows of
 * each, numbered by the prompt's place among the conversation's prompts as /diff counts them
 * (an image sent without words counts too, being a turn here). /diff sees only what followed the
 * last compaction and numbers from there; here, where the turns before it show too, the count
 * runs on through it.
 */
function turnsOf(messages: readonly ChatMessage[], scan: Scan): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  let place = 0;
  for (const message of messages) {
    const text = promptOf(message);
    if (text !== undefined || countsAsPrompt(message)) place += 1;
    if (text !== undefined) {
      turn = { uuid: message.uuid, n: place, text, ...(message.timestamp ? { at: message.timestamp } : {}), rows: [] };
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

/** What each turn of the session in `file` changed, oldest first. `cwd`: the session's folder, for relative paths. */
export async function sessionChanges(file: string, cwd: string | undefined): Promise<SessionChanges> {
  const scan = await scanned(file, cwd);
  const turns: TurnChanges[] = turnsOf(await readHistory(file), scan).map((turn) => ({
    uuid: turn.uuid,
    n: turn.n,
    text: clip(turn.text, 120),
    ...(turn.at ? { at: turn.at } : {}),
    files: filesOf(turn),
    checkpoint: scan.checkpoints.has(turn.uuid),
  }));
  const lines: Record<string, number> = {};
  for (const row of scan.rows.values()) {
    const line = row.edits[0]?.line;
    if (row.toolUseId && line) lines[row.toolUseId] = line;
  }
  return { turns, lines };
}

/** The edit a row recorded, read again from its place in the file. */
async function readEdit(file: string, row: EditRow): Promise<Recorded | undefined> {
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
 * order Claude made them. Empty when the turn did not edit the file.
 */
export async function turnDiff(file: string, cwd: string | undefined, turnId: string, target: string): Promise<string> {
  const scan = await scanned(file, cwd);
  const turn = turnsOf(await readHistory(file), scan).find((t) => t.uuid === turnId);
  const rows = (turn?.rows ?? []).filter(({ row }) => row.edits.some((e) => e.path === target)).map(({ row }) => row);
  if (rows.length === 0) return '';
  const edits = await Promise.all(rows.slice(0, MAX_EDITS_SHOWN).map((row) => readEdit(file, row)));
  const diff = unifiedDiff(target, edits.flatMap((edit) => edit?.hunks ?? []));
  return rows.length > MAX_EDITS_SHOWN ? `${diff}… (${rows.length - MAX_EDITS_SHOWN} more edits of this file in this turn)\n` : diff;
}

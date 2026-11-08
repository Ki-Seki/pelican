import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sessionChanges, turnDiff } from '../src/server/changes';
import { readHistory } from '../src/server/history';
import { lineDiff, splitLines, toHunks } from '../src/shared/line-diff';
import { headerOnly } from '../src/web/lib/diff-header';
import { parseDiff } from '../src/web/lib/review';

/**
 * A transcript as Claude Code writes one: prompts, tool calls, and their results with what the
 * tool recorded (`toolUseResult`), plus a file-history snapshot for each prompt it kept files for.
 */
function transcript(cwd: string) {
  const lines: string[] = [];
  let parent: string | null = null;
  let at = Date.parse('2026-11-05T10:00:00Z');
  const row = (fields: Record<string, unknown>) => {
    const uuid = randomUUID();
    at += 1000;
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, cwd, sessionId: 's1', uuid, timestamp: new Date(at).toISOString(), ...fields }));
    parent = uuid;
    return uuid;
  };
  let calls = 0;
  return {
    lines,
    prompt(text: string, checkpoint = true) {
      const uuid = row({ type: 'user', message: { role: 'user', content: text } });
      if (checkpoint) lines.push(JSON.stringify({ type: 'file-history-snapshot', messageId: uuid, snapshot: { messageId: uuid, trackedFileBackups: {}, timestamp: new Date(at).toISOString() }, isSnapshotUpdate: false }));
      return uuid;
    },
    /** A tool call and its result; `recorded` is what Claude Code keeps of the result. */
    tool(name: string, input: Record<string, unknown>, recorded?: unknown) {
      calls += 1;
      const id = `toolu_${calls}`;
      row({ type: 'assistant', message: { role: 'assistant', id: `msg_${calls}`, content: [{ type: 'tool_use', id, name, input }] } });
      row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, ...(recorded === undefined ? {} : { toolUseResult: recorded }) });
      return id;
    },
    reply(text: string) {
      row({ type: 'assistant', message: { role: 'assistant', id: `msg_r${lines.length}`, content: [{ type: 'text', text }] } });
    },
    /** Any other user row: a `!` command, a command's output, a note Claude Code adds. */
    user(content: string, extra: Record<string, unknown> = {}) {
      return row({ type: 'user', message: { role: 'user', content }, ...extra });
    },
  };
}

const patch = (before: string, after: string) => toHunks(lineDiff(splitLines(before), splitLines(after))!);
const edit = (file: string, before: string, after: string) => ({ filePath: file, oldString: 'x', newString: 'y', originalFile: before, structuredPatch: patch(before, after), userModified: false, replaceAll: false });

let dir: string;
let cwd: string;
let file: string;
const THEME = ':root {\n  --bg: #fff;\n  --fg: #111;\n}\n';
const THEME_DARK = `${THEME}\n[data-theme=dark] {\n  --bg: #000;\n  --fg: #eee;\n}\n`;
const THEME_FIXED = THEME_DARK.replace('--fg: #eee;', '--fg: #ededed;');
const ids: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-changes-'));
  cwd = path.join(dir, 'app');
  file = path.join(dir, 's1.jsonl');
  const t = transcript(cwd);
  ids.first = t.prompt('Add a dark theme\n\nwith a toggle');
  ids.firstEdit = t.tool('Edit', { file_path: `${cwd}/src/theme.css` }, edit(`${cwd}/src/theme.css`, THEME, THEME_DARK));
  t.tool('Write', { file_path: `${cwd}/src/Toggle.tsx` }, { type: 'create', filePath: `${cwd}/src/Toggle.tsx`, content: 'export const Toggle = () => null;\n', structuredPatch: [], originalFile: null });
  // A command that changed a file: only git sees that, as in Claude Code.
  t.tool('Bash', { command: 'sed -i s/a/b/ README.md' }, { stdout: '', stderr: '', interrupted: false });
  t.reply('Done.');
  ids.question = t.prompt('What does the toggle do?', false);
  t.tool('Read', { file_path: `${cwd}/src/Toggle.tsx` }, { type: 'text', file: { filePath: `${cwd}/src/Toggle.tsx`, content: '…' } });
  t.reply('It switches the theme.');
  ids.second = t.prompt('The text is too dim in the dark');
  t.tool('Edit', { file_path: `${cwd}/src/theme.css` }, edit(`${cwd}/src/theme.css`, THEME_DARK, THEME_FIXED));
  // The second edit changes the very line the first one made: the turn changed one line, not two.
  t.tool('Edit', { file_path: `${cwd}/src/theme.css` }, edit(`${cwd}/src/theme.css`, THEME_FIXED, THEME_FIXED.replace('--fg: #ededed;', '--fg: #f0f0f0;')));
  t.tool('MultiEdit', { file_path: `${cwd}/src/App.tsx` }, { filePath: `${cwd}/src/App.tsx`, edits: [], originalFileContents: 'a\nb\nc\n', structuredPatch: patch('a\nb\nc\n', 'a\nB\nc\nd\n'), userModified: false });
  // An edit held for the owner to review changed nothing.
  t.tool('Edit', { file_path: `${cwd}/src/held.ts` }, { ...edit(`${cwd}/src/held.ts`, 'a\n', 'b\n'), staged: true });
  t.tool('Write', { file_path: '/elsewhere/notes.md' }, { type: 'update', filePath: '/elsewhere/notes.md', content: 'new\n', originalFile: 'old\n', structuredPatch: patch('old\n', 'new\n') });
  t.tool('NotebookEdit', { notebook_path: `${cwd}/a.ipynb` }, { notebook_path: `${cwd}/a.ipynb`, old_source: 'x = 1', new_source: 'x = 2\ny = 3', cell_type: 'code', language: 'python', edit_mode: 'replace', original_file: '{}', updated_file: '{}' });
  ids.command = t.prompt('<command-name>/review</command-name>\n<command-args>the theme</command-args>');
  t.tool('Edit', { file_path: `${cwd}/src/theme.css` }, edit(`${cwd}/src/theme.css`, 'one\n', 'two\n'));
  await writeFile(file, `${t.lines.join('\n')}\n`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('changes per turn, from Claude Code’s records', () => {
  it('numbers the prompts that led Claude to edit files by their place, as /diff does, with each file and its lines', async () => {
    const { turns, lines } = await sessionChanges(file, cwd);
    // The question in between changed nothing: it keeps its number, as in Claude Code's /diff.
    expect(turns.map((t) => [t.n, t.text])).toEqual([[1, 'Add a dark theme with a toggle'], [3, 'The text is too dim in the dark'], [4, '/review the theme']]);
    expect(turns[0]!.uuid).toBe(ids.first);
    // A new file counts its lines, as Claude Desktop counts them: the newline at its end ends its one line.
    expect(turns[0]!.files).toEqual([
      { path: 'src/theme.css', added: 5, removed: 0, line: 5 },
      { path: 'src/Toggle.tsx', added: 1, removed: 0, created: true, line: 1 },
    ]);
    // A file Claude edited twice in one turn counts each edit's lines, as /diff does.
    const second = turns[1]!.files;
    expect(second.find((f) => f.path === 'src/theme.css')).toMatchObject({ added: 2, removed: 2 });
    expect(second.find((f) => f.path === 'src/App.tsx')).toMatchObject({ added: 2, removed: 1 });
    expect(second.find((f) => f.path === '/elsewhere/notes.md')).toMatchObject({ added: 1, removed: 1 });
    // A notebook's cells are not in /diff's turns, nor here.
    expect(second.some((f) => f.path === 'a.ipynb')).toBe(false);
    expect(second.some((f) => f.path.includes('held'))).toBe(false);
    expect(turns.flatMap((t) => t.files).some((f) => f.path === 'README.md')).toBe(false);
    expect(turns.map((t) => t.checkpoint)).toEqual([true, true, true]);
    expect(lines[ids.firstEdit!]).toBe(5);
  });

  it('diffs a file over a turn as /diff does: each edit’s patch, in the order Claude made them', async () => {
    const diff = await turnDiff(file, cwd, ids.second!, 'src/theme.css');
    const changed = parseDiff(diff).filter((l) => l.kind === 'add' || l.kind === 'del').map((l) => `${l.kind} ${l.text}`);
    expect(changed).toEqual(['del   --fg: #eee;', 'add   --fg: #ededed;', 'del   --fg: #ededed;', 'add   --fg: #f0f0f0;']);
    expect(await turnDiff(file, cwd, ids.first!, 'src/Toggle.tsx')).toContain('+export const Toggle = () => null;');
    expect(await turnDiff(file, cwd, ids.question!, 'src/theme.css')).toBe('');
    expect(await turnDiff(file, cwd, ids.first!, 'README.md')).toBe('');
  });

  it('follows the session as it grows, reading only what was added', async () => {
    // A copy of its own to grow, read once as it is.
    const grows = path.join(dir, 's1-grows.jsonl');
    await copyFile(file, grows);
    expect((await sessionChanges(grows, cwd)).turns.map((turn) => turn.n)).toEqual([1, 3, 4]);
    const t = transcript(cwd);
    const next = t.prompt('One more');
    t.tool('Write', { file_path: `${cwd}/b.txt` }, { type: 'create', filePath: `${cwd}/b.txt`, content: '1\n2\n', structuredPatch: [], originalFile: null });
    // The new rows continue the conversation from its last row.
    const last = JSON.parse((await readFile(grows, 'utf8')).trimEnd().split('\n').at(-1)!) as { uuid: string };
    const first = JSON.parse(t.lines[0]!) as Record<string, unknown>;
    t.lines[0] = JSON.stringify({ ...first, parentUuid: last.uuid });
    await appendFile(grows, `${t.lines.join('\n')}\n`);
    const { turns } = await sessionChanges(grows, cwd);
    expect(turns.at(-1)).toMatchObject({ uuid: next, n: 5, files: [{ path: 'b.txt', added: 2, removed: 0, created: true }] });
  });
});

describe('turn numbers, as Claude Code’s /diff gives them', () => {
  it('count every prompt it counts: one that changed nothing, a ! command and its output, a command’s output, the summary of a compaction', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-turn-numbers-'));
    try {
      const t = transcript(path.join(work, 'app'));
      t.prompt('What does the theme code do?', false);
      t.reply('It sets the colors.');
      t.user('<bash-input>npm test</bash-input>');
      t.user('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>');
      // Not counted: what Claude Code adds itself.
      t.user('<local-command-caveat>Caveat: run locally.</local-command-caveat>', { isMeta: true });
      t.user('<local-command-stdout>Done</local-command-stdout>');
      t.user('Earlier, the theme was set up.', { isCompactSummary: true });
      const prompt = t.prompt('Add a dark theme');
      t.tool('Edit', { file_path: `${work}/app/theme.css` }, edit(`${work}/app/theme.css`, 'a\nb\n', 'a\nB\n'));
      t.tool('Edit', { file_path: `${work}/app/theme.css` }, edit(`${work}/app/theme.css`, 'a\nB\n', 'a\nBB\n'));
      const transcriptFile = path.join(work, 's1.jsonl');
      await writeFile(transcriptFile, `${t.lines.join('\n')}\n`);
      const { turns } = await sessionChanges(transcriptFile, path.join(work, 'app'));
      expect(turns.map((turn) => [turn.uuid, turn.n, turn.text])).toEqual([[prompt, 6, 'Add a dark theme']]);
      expect(turns[0]!.files).toMatchObject([{ path: 'theme.css', added: 2, removed: 2 }]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('turns as Claude Code’s /diff cuts the conversation into them', () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'pelican-turn-cuts-'));
  });
  afterAll(() => rm(work, { recursive: true, force: true }));
  const changesOf = async (t: ReturnType<typeof transcript>) => {
    const out = path.join(work, `${randomUUID()}.jsonl`);
    await writeFile(out, `${t.lines.join('\n')}\n`);
    return { file: out, ...(await sessionChanges(out, path.join(work, 'app'))) };
  };

  it('give the edits Claude makes in answer to a ! command to that command, numbered by its output, as /diff does', async () => {
    const t = transcript(path.join(work, 'app'));
    t.prompt('Fix the failing tests', false);
    t.reply('Run them and I will look.');
    // As typed: Claude Code writes the command into its row without escaping it.
    const command = t.user('<bash-input>npm test -- --grep "dark" && echo ok</bash-input>');
    t.user('<bash-stdout>FAIL theme.test.ts</bash-stdout><bash-stderr></bash-stderr>');
    t.tool('Edit', { file_path: `${work}/app/theme.css` }, edit(`${work}/app/theme.css`, 'a\nb\n', 'a\nB\n'));
    t.reply('Fixed.');
    // Named as the conversation shows it, without the note Claude Code put in it for Claude.
    const next = t.prompt('<system-reminder>The user is on a phone.</system-reminder>\nThanks, now the toggle');
    t.tool('Edit', { file_path: `${work}/app/Toggle.tsx` }, edit(`${work}/app/Toggle.tsx`, 'x\n', 'y\n'));
    const { turns, file: out } = await changesOf(t);
    // The prompt is 1, the command 2, its output 3 (where /diff starts the turn Claude answers in), the next prompt 4.
    expect(turns.map((turn) => [turn.uuid, turn.n, turn.text])).toEqual([[command, 3, '!npm test -- --grep "dark" && echo ok'], [next, 4, 'Thanks, now the toggle']]);
    expect(turns[0]!.files).toMatchObject([{ path: 'theme.css', added: 1, removed: 1 }]);
    expect(await turnDiff(out, path.join(work, 'app'), command, 'theme.css')).toContain('+B');
  });

  it('give the edits after a background task’s note to that note, as /diff does', async () => {
    const t = transcript(path.join(work, 'app'));
    t.prompt('Build it in the background', false);
    t.reply('Started.');
    const note = t.user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm run build" completed (exit code 0)</summary>\n</task-notification>');
    t.tool('Edit', { file_path: `${work}/app/dist.txt` }, edit(`${work}/app/dist.txt`, 'a\n', 'b\n'));
    const { turns } = await changesOf(t);
    expect(turns.map((turn) => [turn.uuid, turn.n, turn.text])).toEqual([[note, 2, 'Background command "npm run build" completed (exit code 0)']]);
  });

  it('do not count a prompt that is only a picture, which /diff does not, and its edits go with the turn before it', async () => {
    const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const t = transcript(path.join(work, 'app'));
    t.user([picture] as unknown as string);
    t.reply('That is the settings page.');
    const first = t.prompt('Make the toggle bigger');
    t.tool('Edit', { file_path: `${work}/app/Toggle.tsx` }, edit(`${work}/app/Toggle.tsx`, 'a\n', 'b\n'));
    t.user([picture] as unknown as string);
    t.tool('Edit', { file_path: `${work}/app/theme.css` }, edit(`${work}/app/theme.css`, 'a\n', 'b\n'));
    const second = t.prompt('And the text');
    t.tool('Edit', { file_path: `${work}/app/theme.css` }, edit(`${work}/app/theme.css`, 'b\n', 'c\n'));
    const { turns } = await changesOf(t);
    expect(turns.map((turn) => [turn.uuid, turn.n, turn.files.map((f) => f.path)])).toEqual([[first, 1, ['Toggle.tsx', 'theme.css']], [second, 2, ['theme.css']]]);
  });

  it('count a new file’s lines as Claude Desktop does, where a newline ends a line, and an edit that changed nothing not at all', async () => {
    const t = transcript(path.join(work, 'app'));
    const prompt = t.prompt('Add a toggle');
    t.tool('Write', { file_path: `${work}/app/Toggle.tsx` }, { type: 'create', filePath: `${work}/app/Toggle.tsx`, content: 'export const Toggle = () => null;\n', structuredPatch: [], originalFile: null });
    t.tool('Write', { file_path: `${work}/app/b.txt` }, { type: 'create', filePath: `${work}/app/b.txt`, content: '1\n2', structuredPatch: [], originalFile: null });
    t.tool('Write', { file_path: `${work}/app/.keep` }, { type: 'create', filePath: `${work}/app/.keep`, content: '', structuredPatch: [], originalFile: null });
    // Written over with the same text: no patch, so no change.
    t.tool('Write', { file_path: `${work}/app/same.txt` }, { type: 'update', filePath: `${work}/app/same.txt`, content: 'a\n', structuredPatch: [], originalFile: 'a\n' });
    const { turns, file: out } = await changesOf(t);
    // Not as /diff counts them, which takes what follows a file's last newline for one line more.
    expect(turns[0]!.files).toEqual([
      { path: 'Toggle.tsx', added: 1, removed: 0, created: true, line: 1 },
      { path: 'b.txt', added: 2, removed: 0, created: true, line: 1 },
      { path: '.keep', added: 0, removed: 0, created: true },
    ]);
    // The diff shows what the count counts.
    const added = parseDiff(await turnDiff(out, path.join(work, 'app'), prompt, 'Toggle.tsx')).filter((l) => l.kind === 'add').map((l) => l.text);
    expect(added).toEqual(['export const Toggle = () => null;']);
    // A new file with nothing in it, as git's header says one.
    expect(headerOnly(await turnDiff(out, path.join(work, 'app'), prompt, '.keep'))).toBe('A new, empty file');
  });
});

describe('a side chat’s changes', () => {
  it('leave out the turns it copied of its session, which changed that session’s files, not its own', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-side-changes-'));
    try {
      const app = path.join(work, 'app');
      // The conversation it copied, then its own question: one conversation, the copy's rows first.
      const t = transcript(app);
      t.prompt('Add a dark theme');
      t.tool('Edit', { file_path: `${app}/theme.css` }, edit(`${app}/theme.css`, 'a\n', 'b\n'));
      t.reply('Done.');
      const copiedRows = t.lines.length;
      t.prompt('Why CSS variables?', false);
      t.reply('They switch everywhere at once.');
      const rows = t.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const write = async (name: string, change: (row: Record<string, unknown>, copied: boolean) => Record<string, unknown>) => {
        const out = path.join(work, `${name}.jsonl`);
        await writeFile(out, `${rows.map((row, i) => JSON.stringify(change(row, i < copiedRows))).join('\n')}\n`);
        return out;
      };
      // As Claude Code's forkSession copies a session: each copied row says where it came from.
      const side = await write('s1', (row, copied) => (copied ? { ...row, forkedFrom: { sessionId: 'parent', messageUuid: 'x' } } : row));
      expect((await sessionChanges(side, app, true)).turns).toEqual([]);
      expect((await sessionChanges(side, app, true)).lines).toEqual({});
      // Read as a session of its own, the copy shows what the conversation it holds changed.
      expect((await sessionChanges(side, app)).turns).toMatchObject([{ n: 1, text: 'Add a dark theme' }]);

      // Claude Desktop's side chats carry their session's rows under that session's id.
      const desktop = await write('d1', (row, copied) => (copied ? row : { ...row, sessionId: 'd1' }));
      expect((await sessionChanges(desktop, app, true)).turns).toEqual([]);
      expect((await sessionChanges(desktop, app)).turns).toMatchObject([{ n: 1, text: 'Add a dark theme' }]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('the line under a turn and the turn’s steps', () => {
  it('say the same, as in Claude Desktop: each step what its patch, or its new file, records it changed, the turn their sum', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-turn-steps-'));
    try {
      const app = path.join(work, 'app');
      const t = transcript(app);
      t.prompt('Rename the flag and note it');
      // A line changed, and a new file of one line: /diff said 2 files changed, +3 -1.
      t.tool('Edit', { file_path: `${app}/flags.ts` }, edit(`${app}/flags.ts`, 'const on = true;\nexport {};\n', 'const enabled = true;\nexport {};\n'));
      t.tool('Write', { file_path: `${app}/NOTES.md` }, { type: 'create', filePath: `${app}/NOTES.md`, content: 'Renamed the flag.\n', structuredPatch: [], originalFile: null });
      // Every one of three lines; a line added after one that the edit's text stops short of.
      t.tool('Edit', { file_path: `${app}/a.ts` }, { ...edit(`${app}/a.ts`, 'x\nx\nx\n', 'y\ny\ny\n'), replaceAll: true });
      t.tool('Edit', { file_path: `${app}/b.ts` }, edit(`${app}/b.ts`, 'a\nb\nz\n', 'a\nb\nc\nz\n'));
      // Written over with the text it had; held for review; failed: no change, and no count to say.
      t.tool('Write', { file_path: `${app}/same.txt` }, { type: 'update', filePath: `${app}/same.txt`, content: 'a\n', structuredPatch: [], originalFile: 'a\n' });
      t.tool('Edit', { file_path: `${app}/held.ts` }, { ...edit(`${app}/held.ts`, 'a\n', 'b\n'), staged: true });
      t.tool('Edit', { file_path: `${app}/gone.ts` }, 'Error: File does not exist.');
      const out = path.join(work, 's1.jsonl');
      await writeFile(out, `${t.lines.join('\n')}\n`);
      const { turns } = await sessionChanges(out, app);
      expect(turns[0]!.files.map((f) => [f.path, f.added, f.removed])).toEqual([['flags.ts', 1, 1], ['NOTES.md', 1, 0], ['a.ts', 3, 3], ['b.ts', 1, 0]]);
      const steps = (await readHistory(out)).flatMap((m) => m.blocks).flatMap((b) => (b.type === 'tool_result' ? [b.edited] : []));
      expect(steps).toEqual([{ added: 1, removed: 1 }, { added: 1, removed: 0 }, { added: 3, removed: 3 }, { added: 1, removed: 0 }, { added: 0, removed: 0 }, undefined, undefined]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

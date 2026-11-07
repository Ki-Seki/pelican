// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  absolutePath,
  type Action,
  ACTIONS,
  ADD_ACTIONS,
  type AddTarget,
  copyText,
  type Device,
  entries,
  type MenuEntry,
  PATH_ACTIONS,
  type PathTarget,
  PROMPT_ACTIONS,
  type PromptTarget,
  relativePath,
  REPLY_ACTIONS,
  type ReplyTarget,
  runAction,
  SELECTION_ACTIONS,
  type SelectionTarget,
  SESSION_ACTIONS,
  type SessionTarget,
  STEP_ACTIONS,
  type StepTarget,
  swipeAction,
  TERMINAL_ACTIONS,
  type TerminalTarget,
  type Way,
} from '../src/web/lib/actions';
import { announce } from '../src/web/lib/announce';
import { browserKeeps, chordsOf, type KeyId, KEYS, keyWorks, shortcutList } from '../src/web/lib/keyboard';

vi.mock('../src/web/lib/announce', () => ({ announce: vi.fn() }));

const noop = () => {};

/** A list as a computer's menu draws it: a rule (—) before each new part. */
const menu = (list: MenuEntry[]) => list.map((e) => `${e.rule ? '— ' : ''}${e.label}`);
const names = (list: MenuEntry[]) => list.map((e) => e.label);

const session = (extra: Partial<SessionTarget> = {}): SessionTarget => ({
  title: 'Add a dark theme to the settings page',
  archived: false,
  pinned: false,
  from: 'title',
  resume: "cd /code/acme-web && claude --resume 7f3c2a10-0000-4000-8000-000000000001",
  rename: noop,
  pin: noop,
  sideChat: noop,
  fork: noop,
  export: noop,
  view: { value: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'thinking', label: 'Thinking' }, { value: 'verbose', label: 'Verbose' }], choose: noop },
  archive: noop,
  remove: noop,
  ...extra,
});
const prompt = (extra: Partial<PromptTarget> = {}): PromptTarget => ({
  text: 'Now remember the choice, and run the theme tests when you are done.',
  quote: noop, rewind: noop, fork: noop, selectText: noop, ...extra,
});
const add = (extra: Partial<AddTarget> = {}): AddTarget => ({ addFiles: noop, commands: noop, mention: noop, shell: noop, mcp: noop, mcpOn: '1 of 2 on', ...extra });
const reply = (extra: Partial<ReplyTarget> = {}): ReplyTarget => ({
  text: 'Done. All 14 theme tests pass.', markdown: 'Done. All **14** theme tests pass.',
  sideChat: noop, quote: noop, rewind: noop, fork: noop, ...extra,
});
const step = (extra: Partial<StepTarget> = {}): StepTarget => ({
  kind: 'command', command: 'npm test -- theme', output: 'Test Files  2 passed (2)',
  sideChat: noop, runInTerminal: noop, quote: noop, ...extra,
});
const path = (extra: Partial<PathTarget> = {}): PathTarget => ({
  path: 'src/styles/theme.css', cwd: '/code/acme-web', attach: noop, openInFiles: noop, download: noop, ...extra,
});
const selection = (extra: Partial<SelectionTarget> = {}): SelectionTarget => ({ text: 'one more set of values', sideChat: noop, quote: noop, ...extra });
const terminal = (extra: Partial<TerminalTarget> = {}): TerminalTarget => ({
  selection: 'Test Files  2 passed (2)', quote: noop, paste: noop, selectAll: noop, clear: noop, ...extra,
});

/** Each thing with everything it can have, for the rules every list keeps. */
const FULL = {
  session: [SESSION_ACTIONS, [session(), session({ from: 'row' }), session({ archived: true }), session({ pinned: true })]],
  prompt: [PROMPT_ACTIONS, [prompt()]],
  reply: [REPLY_ACTIONS, [reply(), reply({ selection: 'It follows the system', sideChatOpen: true }), reply({ code: 'npm test' })]],
  step: [STEP_ACTIONS, [step(), step({ kind: 'agent', command: undefined, viewOutput: noop, stop: noop })]],
  path: [PATH_ACTIONS, [path({ changed: true, openInChanges: noop }), path({ path: 'src/styles', folder: true, openInTerminal: noop })]],
  selection: [SELECTION_ACTIONS, [selection()]],
  terminal: [TERMINAL_ACTIONS, [terminal()]],
  add: [ADD_ACTIONS, [add()]],
} as unknown as Record<keyof typeof ACTIONS, [readonly Action<unknown>[], unknown[]]>;
const DEVICES: Device[] = ['pointer', 'touch'];
const WAYS: Way[] = ['row', 'menu', 'swipe', 'command'];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the session’s list', () => {
  it('under the title’s ▾: Rename · Pin · Side chat · Fork · Copy resume command · Export · Transcript view · Archive · Delete', () => {
    const list = entries(SESSION_ACTIONS, session(), 'menu', 'pointer');
    expect(menu(list)).toEqual([
      'Rename', 'Pin',
      '— Side chat', 'Fork', 'Copy resume command', 'Export',
      '— Transcript view',
      '— Archive', 'Delete',
    ]);
    expect(list.find((e) => e.id === 'delete')!.danger).toBe(true);
    expect(list.find((e) => e.id === 'transcript-view')).toMatchObject({ choice: { value: 'normal' } });
    // Desktop's keys, each beside what it does: Pin has none on the web, nor does anything that asks first.
    expect(Object.fromEntries(list.filter((e) => e.key).map((e) => [e.id, e.key]))).toEqual({
      rename: 'rename', 'side-chat': 'sideChat', fork: 'fork', 'transcript-view': 'transcriptView', archive: 'archive',
    });
  });

  it('from a row of the list: the same, without the open session’s view', () => {
    expect(menu(entries(SESSION_ACTIONS, session({ from: 'row' }), 'menu', 'pointer'))).toEqual([
      'Rename', 'Pin', '— Side chat', 'Fork', 'Copy resume command', 'Export', '— Archive', 'Delete',
    ]);
  });

  it('on a phone, a short swipe shows Pin and Archive, and a full one archives', () => {
    expect(names(entries(SESSION_ACTIONS, session(), 'row', 'touch'))).toEqual(['Pin', 'Archive']);
    expect(entries(SESSION_ACTIONS, session(), 'row', 'pointer')).toEqual([]);
    expect(swipeAction(SESSION_ACTIONS, session())?.label).toBe('Archive');
  });

  it('says Unpin and Unarchive once done, leaves out Pin for an archived one and Delete while Claude works', () => {
    expect(names(entries(SESSION_ACTIONS, session({ pinned: true }), 'menu', 'touch'))).toContain('Unpin');
    const archived = names(entries(SESSION_ACTIONS, session({ archived: true }), 'menu', 'touch'));
    expect(archived).toContain('Unarchive');
    expect(archived).not.toContain('Pin');
    expect(names(entries(SESSION_ACTIONS, session({ busy: true }), 'menu', 'touch'))).not.toContain('Delete');
  });

  it('leaves out what the page cannot do, never dimming it', () => {
    expect(names(entries(SESSION_ACTIONS, session({ pin: undefined, sideChat: undefined, resume: undefined }), 'menu', 'touch'))).toEqual([
      'Rename', 'Fork', 'Export', 'Transcript view', 'Archive', 'Delete',
    ]);
  });

  it('acts as asked: Pin pins, Archive archives, Unarchive brings back', () => {
    const pin = vi.fn();
    const archive = vi.fn();
    expect(runAction(SESSION_ACTIONS, 'pin', session({ pin }))).toBe(true);
    expect(pin).toHaveBeenCalledWith(true);
    runAction(SESSION_ACTIONS, 'archive', session({ archive, archived: true }));
    expect(archive).toHaveBeenCalledWith(false);
    // An action that does not apply does nothing.
    expect(runAction(SESSION_ACTIONS, 'delete', session({ busy: true }))).toBe(false);
  });

  it('goes by Claude Code’s names in the / list', () => {
    expect(entries(SESSION_ACTIONS, session(), 'command', 'touch').map((e) => e.id)).toEqual(['rename', 'side-chat', 'fork', 'export']);
    expect(SESSION_ACTIONS.filter((a) => a.command).map((a) => a.command!.name)).toEqual(['/rename', '/btw', '/branch', '/export']);
  });
});

describe('your prompt’s list', () => {
  it('long-pressed on a phone: Copy · Quote · Rewind to here · Fork from here · Select text', () => {
    expect(names(entries(PROMPT_ACTIONS, prompt(), 'menu', 'touch'))).toEqual(['Copy', 'Quote', 'Rewind to here', 'Fork from here', 'Select text']);
  });

  it('right-clicked on a computer, where the pointer selects: the same without Select text', () => {
    expect(menu(entries(PROMPT_ACTIONS, prompt(), 'menu', 'pointer'))).toEqual(['Copy', 'Quote', '— Rewind to here', 'Fork from here']);
  });

  it('has no Edit: Rewind to here puts its words back in the box, and Fork from here in a new session’s, as in Desktop', () => {
    for (const device of DEVICES) for (const way of WAYS) expect(names(entries(PROMPT_ACTIONS, prompt(), way, device))).not.toContain('Edit');
    expect(PROMPT_ACTIONS.map((a) => a.id)).not.toContain('edit');
  });

  it('in its row (a tap on a phone, the gutter on a computer): Copy · Rewind to here · Fork from here; a swipe quotes it', () => {
    for (const device of DEVICES) expect(names(entries(PROMPT_ACTIONS, prompt(), 'row', device))).toEqual(['Copy', 'Rewind to here', 'Fork from here']);
    expect(swipeAction(PROMPT_ACTIONS, prompt())?.id).toBe('quote');
  });

  it('copies its words', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    runAction(PROMPT_ACTIONS, 'copy', prompt({ text: 'Keep the colors in CSS variables.' }));
    expect(writeText).toHaveBeenCalledWith('Keep the colors in CSS variables.');
  });
});

describe('Claude’s reply’s list', () => {
  it('its ⋯ on a phone: Copy message · Copy message as Markdown · Start a side chat · Quote message · Rewind to here · Fork from here', () => {
    expect(names(entries(REPLY_ACTIONS, reply(), 'menu', 'touch'))).toEqual([
      'Copy message', 'Copy message as Markdown', 'Start a side chat', 'Quote message', 'Rewind to here', 'Fork from here',
    ]);
  });

  it('right-clicked on a selection: its Copy ⌘C first, then the reply’s list, quoting and asking about the selection', () => {
    const sideChat = vi.fn();
    const quote = vi.fn();
    const list = entries(REPLY_ACTIONS, reply({ selection: 'It follows the system until you pick one.', sideChat, quote }), 'menu', 'pointer');
    expect(menu(list)).toEqual([
      'Copy',
      '— Copy message', 'Copy message as Markdown',
      '— Start a side chat', 'Quote selection',
      '— Rewind to here', 'Fork from here',
    ]);
    expect(list[0]!.key).toBe('copy');
    // ⇧⌘L shows beside Quote selection once it quotes without a note (the next part of 0.5.0).
    const quoteAction = REPLY_ACTIONS.find((a) => a.id === 'quote')!;
    expect(typeof quoteAction.key === 'function' && quoteAction.key(reply({ selection: 'x' }))).toBe('quoteSelection');
    expect(list.find((e) => e.id === 'quote')!.key).toBe(keyWorks('quoteSelection') ? 'quoteSelection' : undefined);
    for (const e of list.filter((x) => x.id === 'side-chat' || x.id === 'quote')) if ('run' in e) e.run();
    expect(sideChat).toHaveBeenCalledWith('It follows the system until you pick one.');
    expect(quote).toHaveBeenCalledWith('It follows the system until you pick one.');
  });

  it('right-clicked on a code block: Copy code first; with a side chat open, Send to side chat', () => {
    expect(names(entries(REPLY_ACTIONS, reply({ code: 'npm test' }), 'menu', 'pointer'))[0]).toBe('Copy code');
    expect(names(entries(REPLY_ACTIONS, reply({ sideChatOpen: true }), 'menu', 'touch'))).toContain('Send to side chat');
  });

  it('in its row: Copy on a phone, Copy and Fork from here on a computer; a swipe quotes the paragraph', () => {
    expect(names(entries(REPLY_ACTIONS, reply(), 'row', 'touch'))).toEqual(['Copy message']);
    expect(names(entries(REPLY_ACTIONS, reply(), 'row', 'pointer'))).toEqual(['Copy message', 'Fork from here']);
    const quote = vi.fn();
    const swiped = swipeAction(REPLY_ACTIONS, reply({ selection: 'All 14 theme tests pass.', quote }))!;
    if ('run' in swiped) swiped.run();
    expect(quote).toHaveBeenCalledWith('All 14 theme tests pass.');
  });

  it('copies the reply as it reads, or as Claude wrote it', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    runAction(REPLY_ACTIONS, 'copy-message', reply());
    runAction(REPLY_ACTIONS, 'copy-markdown', reply());
    expect(writeText.mock.calls).toEqual([['Done. All 14 theme tests pass.'], ['Done. All **14** theme tests pass.']]);
  });
});

describe('a step’s list', () => {
  it('a command: Copy command · Run in terminal · Copy output · Start a side chat · Quote output, and a swipe quotes its output', () => {
    expect(menu(entries(STEP_ACTIONS, step(), 'menu', 'pointer'))).toEqual([
      'Copy command', 'Run in terminal', '— Copy output', 'Start a side chat', 'Quote output',
    ]);
    const quote = vi.fn();
    const swiped = swipeAction(STEP_ACTIONS, step({ quote }))!;
    if ('run' in swiped) swiped.run();
    expect(quote).toHaveBeenCalledWith('Test Files  2 passed (2)');
  });

  it('without a terminal or any output: what is left', () => {
    expect(names(entries(STEP_ACTIONS, step({ runInTerminal: undefined, output: '  ' }), 'menu', 'touch'))).toEqual(['Copy command', 'Start a side chat']);
  });

  it('an agent: View output · Stop', () => {
    expect(names(entries(STEP_ACTIONS, step({ kind: 'agent', command: undefined, viewOutput: noop, stop: noop }), 'menu', 'touch'))).toEqual(['View output', 'Stop']);
  });
});

describe('a path’s list', () => {
  it('a file, from Changes: Attach as context · Copy ▸ · Open in Files · Download file', () => {
    const list = entries(PATH_ACTIONS, path(), 'menu', 'pointer');
    expect(menu(list)).toEqual(['Attach as context', 'Copy', '— Open in Files', 'Download file']);
    const copy = list.find((e) => e.id === 'copy')!;
    expect('items' in copy && names(copy.items)).toEqual(['Absolute path', 'Relative path', 'Filename']);
  });

  it('a file with changes, elsewhere: Open in Changes before Open in Files; a folder: Open in terminal, no Download', () => {
    expect(names(entries(PATH_ACTIONS, path({ changed: true, openInChanges: noop }), 'menu', 'touch'))).toEqual([
      'Attach as context', 'Copy', 'Open in Changes', 'Open in Files', 'Download file',
    ]);
    // Open in Changes is a file's: a folder has changes in none of Desktop's lists.
    expect(names(entries(PATH_ACTIONS, path({ path: 'src/styles', folder: true, changed: true, openInChanges: noop, openInTerminal: noop }), 'menu', 'touch'))).toEqual([
      'Attach as context', 'Copy', 'Open in Files', 'Open in terminal',
    ]);
  });

  it('copies the path from the root, from the session’s folder, or its name', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copy = entries(PATH_ACTIONS, path(), 'menu', 'touch').find((e) => e.id === 'copy')!;
    if ('items' in copy) for (const item of copy.items) if ('run' in item) item.run();
    expect(writeText.mock.calls).toEqual([['/code/acme-web/src/styles/theme.css'], ['src/styles/theme.css'], ['theme.css']]);
  });

  it('has no relative path for a file outside the session’s folder', () => {
    const copy = entries(PATH_ACTIONS, path({ path: '/etc/hosts' }), 'menu', 'touch').find((e) => e.id === 'copy')!;
    expect('items' in copy && names(copy.items)).toEqual(['Absolute path', 'Filename']);
    expect(absolutePath('./src/../README.md', '/code/acme-web/')).toBe('/code/acme-web/README.md');
    expect(absolutePath('/etc/hosts', '/code/acme-web')).toBe('/etc/hosts');
    expect(relativePath('/code/acme-web/src/a.ts', '/code/acme-web')).toBe('src/a.ts');
    expect(relativePath('../other/a.ts', '/code/acme-web')).toBeUndefined();
    expect(relativePath('./src/a.ts')).toBe('src/a.ts');
  });
});

describe('a selection’s list', () => {
  it('is Desktop’s pair, in its order and words: Start a side chat (Send to side chat) · Quote', () => {
    expect(names(entries(SELECTION_ACTIONS, selection(), 'menu', 'pointer'))).toEqual(['Start a side chat', 'Quote']);
    expect(names(entries(SELECTION_ACTIONS, selection({ sideChatOpen: true }), 'menu', 'touch'))).toEqual(['Send to side chat', 'Quote']);
    expect(SELECTION_ACTIONS.find((a) => a.id === 'quote')!.key).toBe('quote');
  });
});

describe('the terminal’s list', () => {
  it('right-clicked on output: Quote · Copy · Paste · Select all · Clear terminal, with the browser’s keys beside its own', () => {
    const list = entries(TERMINAL_ACTIONS, terminal(), 'menu', 'pointer');
    expect(menu(list)).toEqual(['Quote', 'Copy', 'Paste', 'Select all', '— Clear terminal']);
    expect(list.map((e) => e.key ?? '')).toEqual([keyWorks('quoteSelection') ? 'quoteSelection' : '', 'copy', 'paste', 'selectAll', '']);
    expect(names(entries(TERMINAL_ACTIONS, terminal({ selection: undefined }), 'menu', 'pointer'))).toEqual(['Paste', 'Select all', 'Clear terminal']);
  });
});

describe('the message box’s +', () => {
  it('is Desktop’s: Add files or photos · Commands · Files and agents · Shell command, then MCP servers with how many are on', () => {
    const list = entries(ADD_ACTIONS, add(), 'menu', 'pointer');
    expect(menu(list)).toEqual(['Add files or photos', 'Commands', 'Files and agents', 'Shell command', '— MCP servers']);
    expect(list.map((e) => e.key ?? '')).toEqual(['addFiles', 'commands', 'mention', 'shell', '']);
    expect(list.at(-1)).toMatchObject({ detail: '1 of 2 on', opens: true });
  });

  it('leaves out what the box cannot do: a shell command where there is none, MCP servers before a session starts', () => {
    expect(names(entries(ADD_ACTIONS, add({ shell: undefined, mcp: undefined }), 'menu', 'touch'))).toEqual(['Add files or photos', 'Commands', 'Files and agents']);
  });
});

describe('every list', () => {
  it('shows its actions in the same order in every way in, each way a part of the whole list', () => {
    for (const [thing, [list, targets]] of Object.entries(FULL)) {
      for (const target of targets) {
        for (const device of DEVICES) {
          const all = entries(list, target, 'menu', device).map((e) => e.id);
          for (const way of WAYS) {
            const ids = entries(list, target, way, device).map((e) => e.id);
            expect(ids.every((id) => all.includes(id)), `${thing} ${way} ${device}`).toBe(true);
            expect(ids, `${thing} ${way} ${device}`).toEqual(all.filter((id) => ids.includes(id)));
          }
        }
      }
    }
  });

  it('has a way in for every action that needs no hover: right-click on a computer, a long press or ⋯ on a phone', () => {
    for (const [thing, [list, targets]] of Object.entries(FULL)) {
      for (const action of list) {
        const reached = targets.some((target) => DEVICES.some((device) => entries(list, target, 'menu', device).some((e) => e.id === action.id)));
        expect(reached, `${thing}: ${action.id}`).toBe(true);
      }
    }
  });

  it('names one action by a key in any one list, and only a key that works, listed in ⌘/ or the browser’s own', () => {
    const listed = new Set(shortcutList({ enterSends: true }).flatMap((part) => part.rows.map((row) => row.id)));
    for (const [thing, [list, targets]] of Object.entries(FULL)) {
      for (const target of targets) {
        for (const device of DEVICES) {
          const keys = entries(list, target, 'menu', device).map((e) => e.key).filter((key): key is KeyId => Boolean(key));
          expect(new Set(keys).size, `${thing} ${device}`).toBe(keys.length);
          for (const key of keys) {
            expect(keyWorks(key)).toBe(true);
            expect(listed.has(key) || 'browser' in KEYS[key], `${thing}: ${key}`).toBe(true);
          }
        }
      }
      // Every key an action may carry, working or still to come, is in the key table, and none of
      // Pelican's is a browser's.
      for (const action of list) {
        const keys = typeof action.key === 'function' ? targets.map((target) => (action.key as (t: unknown) => KeyId | undefined)(target)) : [action.key];
        for (const key of keys.filter((k): k is KeyId => Boolean(k))) {
          expect(KEYS[key], `${thing}: ${action.id}`).toBeDefined();
          if (!('browser' in KEYS[key])) for (const apple of [true, false]) expect(browserKeeps(chordsOf(key)[0]!, apple)).toBe(false);
        }
      }
    }
  });

  it('gives each action something to do, and a swipe at most one', () => {
    for (const [thing, [list]] of Object.entries(FULL)) {
      expect(list.filter((a) => a.swipe).length, thing).toBeLessThanOrEqual(1);
      expect(new Set(list.map((a) => a.id)).size, thing).toBe(list.length);
    }
  });
});

describe('copying', () => {
  it('uses the clipboard where the page may, and says so', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
    await expect(copyText('npm test -- theme')).resolves.toBe(true);
    expect(announce).toHaveBeenLastCalledWith('Copied');
  });

  it('copies the old way over plain http, where a page has no clipboard, and gives focus back', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    const before = document.createElement('input');
    document.body.append(before);
    before.focus();
    try {
      await expect(copyText('npm test -- theme')).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
      // The field it copied from is gone, and focus is back where it was.
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.activeElement).toBe(before);
      execCommand.mockReturnValue(false);
      await expect(copyText('npm test -- theme')).resolves.toBe(false);
      expect(announce).toHaveBeenLastCalledWith('Could not copy');
    } finally {
      before.remove();
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });
});

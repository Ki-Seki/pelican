import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CircleStop,
  Clipboard,
  Copy,
  Download,
  Eraser,
  Eye,
  FileDiff,
  FileText,
  FolderOpen,
  GitFork,
  History,
  MessagesSquare,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plug,
  ScrollText,
  Slash,
  SquareCode,
  SquareTerminal,
  TextCursor,
  TextQuote,
  TextSelect,
  Trash2,
} from 'lucide-react';

import { announce } from './announce';
import { baseName } from './format';
import { type KeyId, keyWorks } from './keyboard';
import { inFolder } from './path-links';

/**
 * What can be done with each thing you act on (a session, your prompt, Claude's reply, a step, a
 * file's path, a selection, terminal output), one list each, in Claude Desktop's words and order.
 * Every way in shows its thing's list from here: the quiet row on the thing, ⋯, right-click, the
 * long press's sheet, a swipe, the / list and ⌘K, and the keys in the list of keys (lib/keyboard).
 * So each shows the same actions in the same order, and an action the page cannot do there is left
 * out, never dimmed.
 */

/** A screen with a pointer that can hover (a computer), or a finger's (a phone). */
export type Device = 'pointer' | 'touch';

/** A way into a thing's list. */
export type Way =
  /** The quiet row on the thing: always there on a phone, on hover or focus on a computer. */
  | 'row'
  /** ⋯, right-click, a long press, a title's ▾: the whole list. */
  | 'menu'
  /** A left swipe on a phone, never a right one (that is Back). */
  | 'swipe'
  /** The / list in the message box, and ⌘K, by Claude Code's names. */
  | 'command';

/** A choice of a few, in place of a command: the transcript view. */
export type Choice = {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  choose: (value: string) => void;
};

type Shown<T, V> = V | ((target: T) => V);

/** One thing an action list can do. */
export type Action<T> = {
  /** Its name, the same in every way in. */
  id: string;
  label: Shown<T, string>;
  icon?: LucideIcon;
  /** An icon that changes with the thing (Pin, Unpin), in place of `icon`. */
  iconFor?: (target: T) => LucideIcon;
  /** Desktop's web key for it (lib/keyboard), shown faintly in a menu on a computer once it works. */
  key?: Shown<T, KeyId | undefined>;
  /** A few words after its name, faintly: how many MCP servers are on. */
  detail?: Shown<T, string | undefined>;
  /** It opens a sheet of its own, which a chevron says. */
  opens?: true;
  /** Claude Code's command for it, as the / list and ⌘K show it. */
  command?: { name: string; description: string };
  /** The part of the list it is in: a computer's menu draws a rule between parts. */
  group: string;
  /** Also on the thing itself, in its quiet row: on both kinds of screen, or on one. */
  row?: true | Device;
  /** What a left swipe on a phone does; one action of a list at most. */
  swipe?: true;
  /** Not in the thing's menu: reached by its command alone, typed (/rewind, which asks which message). */
  menu?: false;
  /** Only on one kind of screen. */
  only?: Device;
  /** Undoes nothing, and shows in red, last. */
  danger?: true;
  /** Whether it applies to this one; otherwise it is left out of every way in. */
  when?: (target: T) => boolean;
} & (
  | { run: (target: T) => void; items?: never; choice?: never }
  /** A list one level down: a submenu on a computer, rows that open in place on a phone. */
  | { items: readonly Action<T>[]; run?: never; choice?: never }
  | { choice: (target: T) => Choice | undefined; run?: never; items?: never }
);

/** An action as a way in shows it, for one thing. */
export type MenuEntry = {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** The key, when one works for it now. */
  key?: KeyId;
  detail?: string;
  opens?: boolean;
  danger?: boolean;
  /** The first of its part, after another part: under a rule on a computer. */
  rule?: boolean;
} & ({ run: () => void } | { items: MenuEntry[] } | { choice: Choice });

const shown = <T, V>(value: Shown<T, V>, target: T): V => (typeof value === 'function' ? (value as (t: T) => V)(target) : value);

function applies<T>(action: Action<T>, target: T, device: Device): boolean {
  if (action.only && action.only !== device) return false;
  return action.when ? action.when(target) : true;
}

function inWay<T>(action: Action<T>, way: Way, device: Device): boolean {
  if (way === 'row') return action.row === true || action.row === device;
  if (way === 'swipe') return Boolean(action.swipe);
  if (way === 'command') return Boolean(action.command);
  return action.menu !== false;
}

function entry<T>(action: Action<T>, target: T, device: Device): MenuEntry | undefined {
  const key = action.key === undefined ? undefined : shown(action.key, target);
  const icon = action.iconFor ? action.iconFor(target) : action.icon;
  const detail = action.detail === undefined ? undefined : shown(action.detail, target);
  const base = {
    id: action.id,
    label: shown(action.label, target),
    ...(icon ? { icon } : {}),
    ...(key && keyWorks(key) ? { key } : {}),
    ...(detail ? { detail } : {}),
    ...(action.opens ? { opens: true } : {}),
    ...(action.danger ? { danger: true } : {}),
  };
  if (action.items) {
    const items = entries(action.items, target, 'menu', device);
    return items.length > 0 ? { ...base, items } : undefined;
  }
  if (action.choice) {
    const choice = action.choice(target);
    return choice ? { ...base, choice } : undefined;
  }
  const { run } = action;
  return { ...base, run: () => run(target) };
}

/**
 * A thing's actions for one way in, in its list's order: those that apply to it, on this kind of
 * screen. A menu's parts are marked where a computer draws a rule.
 */
export function entries<T>(list: readonly Action<T>[], target: T, way: Way, device: Device): MenuEntry[] {
  const out: MenuEntry[] = [];
  let group: string | undefined;
  for (const action of list) {
    if (!inWay(action, way, device) || !applies(action, target, device)) continue;
    const made = entry(action, target, device);
    if (!made) continue;
    if (way === 'menu' && group !== undefined && action.group !== group) made.rule = true;
    group = action.group;
    out.push(made);
  }
  return out;
}

/** What a left swipe does to this thing, if anything. */
export const swipeAction = <T>(list: readonly Action<T>[], target: T): MenuEntry | undefined => entries(list, target, 'swipe', 'touch')[0];

/** One of a thing's actions as the / list and ⌘K show it (lib/commands): Claude Code's name for it, without the /, and the list's words. */
export type CommandEntry = { id: string; label: string; icon?: LucideIcon; key?: KeyId; name: string; description: string; run: () => void };

/** The action `id` by its command, as it applies to this thing now; none when it does not. */
export function commandOf<T>(list: readonly Action<T>[], id: string, target: T, device: Device): CommandEntry | undefined {
  const action = list.find((a) => a.id === id);
  const made = action?.command && entries([action], target, 'command', device)[0];
  if (!action?.command || !made || !('run' in made)) return undefined;
  return { id, label: made.label, ...(made.icon ? { icon: made.icon } : {}), ...(made.key ? { key: made.key } : {}), name: action.command.name.replace(/^\//, ''), description: action.command.description, run: made.run };
}

/** Runs a thing's action by its id, as a key or a way in that names it does. */
export function runAction<T>(list: readonly Action<T>[], id: string, target: T, device: Device = 'pointer'): boolean {
  const found = entries(list, target, 'menu', device).find((made) => made.id === id);
  if (!found || !('run' in found)) return false;
  found.run();
  return true;
}

/**
 * Puts text on the clipboard. A page served over plain http (a phone on the local network) has no
 * clipboard API; there the text is copied the old way, from a field that is there for a moment.
 */
export async function copyText(text: string): Promise<boolean> {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    // Refused (no permission, or the page is not in front): the old way may still work.
  }
  if (!copied && typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    const back = document.activeElement;
    document.body.append(field);
    field.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    field.remove();
    if (back instanceof HTMLElement) back.focus({ preventScroll: true });
  }
  announce(copied ? 'Copied' : 'Could not copy');
  return copied;
}

const copy = (text: string | undefined) => {
  if (text) void copyText(text);
};

/** A path from the root, as the computer has it, from the session's folder for one Claude names from there. */
export function absolutePath(path: string, cwd?: string): string {
  if (path.startsWith('/') || path.startsWith('~') || !cwd) return path;
  const out: string[] = [];
  for (const part of `${cwd.replace(/\/+$/, '')}/${path}`.split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/') || '/';
}

/** A path from the session's folder, as Claude names the files in it; none for one outside it. */
export function relativePath(path: string, cwd?: string): string | undefined {
  if (!cwd) return path.startsWith('/') || path.startsWith('~') ? undefined : path.replace(/^(?:\.\/)+/, '');
  return inFolder(absolutePath(path, cwd), cwd);
}

const sideChatLabel = (open: boolean | undefined) => (open ? 'Send to side chat' : 'Start a side chat');

/* ---------- a session ---------- */

/** A session, from the title's ▾ of the open one or from its row in the list. */
export type SessionTarget = {
  title: string;
  archived: boolean;
  pinned: boolean;
  /**
   * Where its list was opened: the open session's title, which has its keys and its view, or a row
   * of the list, which may be another session's (keys act on the open one, so it shows none).
   */
  from: 'title' | 'row';
  /** Claude works in it: it is deleted once Claude stops. */
  busy?: boolean;
  /** The command that carries it on in a terminal (lib/format resumeCommand). */
  resume?: string;
  // What the page can do with it; anything it cannot is left out.
  rename?: () => void;
  pin?: (pinned: boolean) => void;
  sideChat?: () => void;
  fork?: () => void;
  /** Asks which of its messages to rewind to (/rewind). */
  rewind?: () => void;
  export?: () => void;
  view?: Choice;
  archive?: (archived: boolean) => void;
  remove?: () => void;
};

/**
 * The session's menu: Rename · Pin · Side chat · Fork · Copy resume command · Export · Transcript
 * view · Archive · Delete. /rewind is the session's by its command alone: it asks which message,
 * whose own Rewind to here (on the prompt, its reply's ⋯) does the rest.
 */
export const SESSION_ACTIONS: readonly Action<SessionTarget>[] = [
  {
    id: 'rename', group: 'name', label: 'Rename', icon: Pencil, key: 'rename',
    command: { name: '/rename', description: 'Rename this session' },
    when: (s) => Boolean(s.rename), run: (s) => s.rename?.(),
  },
  {
    id: 'pin', group: 'name', label: (s) => (s.pinned ? 'Unpin' : 'Pin'), iconFor: (s) => (s.pinned ? PinOff : Pin), row: 'touch',
    when: (s) => Boolean(s.pin) && !s.archived, run: (s) => s.pin?.(!s.pinned),
  },
  {
    id: 'side-chat', group: 'more', label: 'Side chat', icon: MessagesSquare, key: 'sideChat',
    command: { name: '/btw', description: 'Ask in side chat' },
    when: (s) => Boolean(s.sideChat), run: (s) => s.sideChat?.(),
  },
  {
    id: 'fork', group: 'more', label: 'Fork', icon: GitFork, key: 'fork',
    command: { name: '/branch', description: 'Fork from here · new session' },
    when: (s) => Boolean(s.fork), run: (s) => s.fork?.(),
  },
  {
    id: 'rewind', group: 'more', label: 'Rewind to an earlier message', icon: History, menu: false,
    command: { name: '/rewind', description: 'Rewind to an earlier message' },
    when: (s) => Boolean(s.rewind), run: (s) => s.rewind?.(),
  },
  { id: 'copy-resume', group: 'more', label: 'Copy resume command', icon: SquareTerminal, when: (s) => Boolean(s.resume), run: (s) => copy(s.resume) },
  {
    id: 'export', group: 'more', label: 'Export', icon: Download,
    command: { name: '/export', description: 'Export' },
    when: (s) => Boolean(s.export), run: (s) => s.export?.(),
  },
  // The view of the open session; a row's list may be another's.
  { id: 'transcript-view', group: 'view', label: 'Transcript view', icon: Eye, key: 'transcriptView', when: (s) => s.from === 'title', choice: (s) => s.view },
  {
    id: 'archive', group: 'end', label: (s) => (s.archived ? 'Unarchive' : 'Archive'), iconFor: (s) => (s.archived ? ArchiveRestore : Archive), key: 'archive',
    row: 'touch', swipe: true,
    when: (s) => Boolean(s.archive), run: (s) => s.archive?.(!s.archived),
  },
  // Not while Claude works in it: it is left out until Claude stops, as an action that cannot be is.
  { id: 'delete', group: 'end', label: 'Delete', icon: Trash2, danger: true, when: (s) => Boolean(s.remove) && !s.busy, run: (s) => s.remove?.() },
];

/* ---------- your prompt ---------- */

/** One of your prompts, which stands for its whole turn. */
export type PromptTarget = {
  /** Its words, as they were sent. */
  text: string;
  quote?: () => void;
  /** Back to before it, its words back in the box: how a prompt is edited, as in Claude Code and Desktop. */
  rewind?: () => void;
  fork?: () => void;
  /** Lets a finger select its words, which a long press takes otherwise. */
  selectText?: () => void;
};

/**
 * Copy · Quote · Rewind to here · Fork from here, and Select text on a phone. Editing a prompt is
 * Rewind to here, which puts its words back in the box, or Fork from here, which puts them in a
 * new session's, as in Claude Desktop and the CLI.
 */
export const PROMPT_ACTIONS: readonly Action<PromptTarget>[] = [
  { id: 'copy', group: 'text', label: 'Copy', icon: Copy, row: true, run: (p) => copy(p.text) },
  { id: 'quote', group: 'text', label: 'Quote', icon: TextQuote, swipe: true, when: (p) => Boolean(p.quote), run: (p) => p.quote?.() },
  { id: 'rewind', group: 'turn', label: 'Rewind to here', icon: History, row: true, when: (p) => Boolean(p.rewind), run: (p) => p.rewind?.() },
  { id: 'fork', group: 'turn', label: 'Fork from here', icon: GitFork, row: true, when: (p) => Boolean(p.fork), run: (p) => p.fork?.() },
  // A computer selects with the pointer as ever; a long press on a phone takes the words' own.
  { id: 'select-text', group: 'select', label: 'Select text', icon: TextCursor, only: 'touch', when: (p) => Boolean(p.selectText), run: (p) => p.selectText?.() },
];

/* ---------- Claude's reply ---------- */

/** Claude's reply, with what was right-clicked in it, if anything. */
export type ReplyTarget = {
  /** The reply as it reads. */
  text: string;
  /** The reply as Claude wrote it. */
  markdown: string;
  /** Text selected in it, or the paragraph a swipe is on: what Quote and the side chat take. */
  selection?: string;
  /** A code block that was right-clicked. */
  code?: string;
  /** A side chat is open for this session: the side chat action sends to it. */
  sideChatOpen?: boolean;
  sideChat?: (passage?: string) => void;
  quote?: (passage: string) => void;
  rewind?: () => void;
  fork?: () => void;
};

/**
 * What was right-clicked first (the selection's Copy ⌘C, a code block's Copy code), then Copy
 * message · Copy message as Markdown · Start a side chat · Quote · Rewind to here · Fork from here.
 */
export const REPLY_ACTIONS: readonly Action<ReplyTarget>[] = [
  { id: 'copy-selection', group: 'clicked', label: 'Copy', icon: Copy, key: 'copy', only: 'pointer', when: (r) => Boolean(r.selection), run: (r) => copy(r.selection) },
  { id: 'copy-code', group: 'clicked', label: 'Copy code', icon: SquareCode, when: (r) => Boolean(r.code) && !r.selection, run: (r) => copy(r.code) },
  { id: 'copy-message', group: 'copy', label: 'Copy message', icon: Copy, row: true, run: (r) => copy(r.text) },
  { id: 'copy-markdown', group: 'copy', label: 'Copy message as Markdown', icon: FileText, run: (r) => copy(r.markdown) },
  { id: 'side-chat', group: 'ask', label: (r) => sideChatLabel(r.sideChatOpen), icon: MessagesSquare, when: (r) => Boolean(r.sideChat), run: (r) => r.sideChat?.(r.selection) },
  {
    id: 'quote', group: 'ask', label: (r) => (r.selection ? 'Quote selection' : 'Quote message'), icon: TextQuote,
    key: (r) => (r.selection ? 'quoteSelection' : undefined), swipe: true,
    when: (r) => Boolean(r.quote), run: (r) => r.quote?.(r.selection ?? r.text),
  },
  // As Desktop's message menu does, these act on the turn's prompt.
  { id: 'rewind', group: 'turn', label: 'Rewind to here', icon: History, when: (r) => Boolean(r.rewind), run: (r) => r.rewind?.() },
  { id: 'fork', group: 'turn', label: 'Fork from here', icon: GitFork, row: 'pointer', when: (r) => Boolean(r.fork), run: (r) => r.fork?.() },
];

/* ---------- a step ---------- */

/** A step of Claude's: a command it ran, or an agent. A step on a file shows the path's list (PATH_ACTIONS). */
export type StepTarget = {
  kind: 'command' | 'agent';
  /** A command step's command. */
  command?: string;
  /** What it printed, or the agent returned. */
  output?: string;
  sideChatOpen?: boolean;
  sideChat?: (passage?: string) => void;
  runInTerminal?: () => void;
  quote?: (passage: string) => void;
  /** An agent's: its steps and output, live while it runs. */
  viewOutput?: () => void;
  stop?: () => void;
};

/** Copy command · Run in terminal · Copy output · Start a side chat · Quote output; an agent's View output · Stop. */
export const STEP_ACTIONS: readonly Action<StepTarget>[] = [
  { id: 'copy-command', group: 'command', label: 'Copy command', icon: Copy, when: (s) => s.kind === 'command' && Boolean(s.command), run: (s) => copy(s.command) },
  { id: 'run-in-terminal', group: 'command', label: 'Run in terminal', icon: SquareTerminal, when: (s) => s.kind === 'command' && Boolean(s.command && s.runInTerminal), run: (s) => s.runInTerminal?.() },
  { id: 'copy-output', group: 'output', label: 'Copy output', icon: Clipboard, when: (s) => s.kind === 'command' && Boolean(s.output?.trim()), run: (s) => copy(s.output) },
  { id: 'side-chat', group: 'output', label: (s) => sideChatLabel(s.sideChatOpen), icon: MessagesSquare, when: (s) => s.kind === 'command' && Boolean(s.sideChat), run: (s) => s.sideChat?.(s.output) },
  {
    id: 'quote-output', group: 'output', label: 'Quote output', icon: TextQuote, swipe: true,
    when: (s) => s.kind === 'command' && Boolean(s.quote && s.output?.trim()), run: (s) => s.quote?.(s.output!),
  },
  { id: 'view-output', group: 'agent', label: 'View output', icon: ScrollText, when: (s) => s.kind === 'agent' && Boolean(s.viewOutput), run: (s) => s.viewOutput?.() },
  { id: 'stop', group: 'agent', label: 'Stop', icon: CircleStop, when: (s) => s.kind === 'agent' && Boolean(s.stop), run: (s) => s.stop?.() },
];

/* ---------- a file's or a folder's path ---------- */

/** A path wherever it shows: in a reply, a step, Changes, Files or a file. */
export type PathTarget = {
  /** As it was named: from the session's folder, or from the root. */
  path: string;
  /** The session's folder. */
  cwd?: string;
  folder?: boolean;
  /** A file with changes to show (in git, or a turn's). */
  changed?: boolean;
  attach?: () => void;
  openInChanges?: () => void;
  openInFiles?: () => void;
  openInTerminal?: () => void;
  download?: () => void;
};

/**
 * Desktop's path menu: Attach as context · Copy ▸ (Absolute path, Relative path, Filename) · Open in
 * Changes (a file with changes) · Open in Files · Download file; a folder has Open in terminal.
 * Desktop's editors, default app and Finder are left out: they would act on the far computer.
 */
export const PATH_ACTIONS: readonly Action<PathTarget>[] = [
  { id: 'attach', group: 'use', label: 'Attach as context', icon: Paperclip, when: (p) => Boolean(p.attach), run: (p) => p.attach?.() },
  {
    id: 'copy', group: 'use', label: 'Copy', icon: Copy,
    items: [
      { id: 'copy-absolute', group: 'copy', label: 'Absolute path', run: (p) => copy(absolutePath(p.path, p.cwd)) },
      { id: 'copy-relative', group: 'copy', label: 'Relative path', when: (p) => Boolean(relativePath(p.path, p.cwd)), run: (p) => copy(relativePath(p.path, p.cwd)) },
      { id: 'copy-name', group: 'copy', label: (p) => (p.folder ? 'Folder name' : 'Filename'), run: (p) => copy(baseName(p.path)) },
    ],
  },
  { id: 'open-in-changes', group: 'open', label: 'Open in Changes', icon: FileDiff, when: (p) => !p.folder && Boolean(p.changed && p.openInChanges), run: (p) => p.openInChanges?.() },
  { id: 'open-in-files', group: 'open', label: 'Open in Files', iconFor: (p) => (p.folder ? FolderOpen : FileText), when: (p) => Boolean(p.openInFiles), run: (p) => p.openInFiles?.() },
  { id: 'open-in-terminal', group: 'open', label: 'Open in terminal', icon: SquareTerminal, when: (p) => Boolean(p.folder && p.openInTerminal), run: (p) => p.openInTerminal?.() },
  { id: 'download', group: 'open', label: 'Download file', icon: Download, when: (p) => !p.folder && Boolean(p.download), run: (p) => p.download?.() },
];

/* ---------- a selection ---------- */

/** Text selected in the conversation. */
export type SelectionTarget = {
  text: string;
  sideChatOpen?: boolean;
  sideChat?: () => void;
  /** Quotes it with a note: Desktop's note box on a computer, the message box on a phone. */
  quote?: () => void;
};

/** Exactly two, in Desktop's order and words: Start a side chat (or Send to side chat) · Quote ↵. */
export const SELECTION_ACTIONS: readonly Action<SelectionTarget>[] = [
  { id: 'side-chat', group: 'ask', label: (s) => sideChatLabel(s.sideChatOpen), icon: MessagesSquare, when: (s) => Boolean(s.sideChat), run: (s) => s.sideChat?.() },
  { id: 'quote', group: 'ask', label: 'Quote', icon: TextQuote, key: 'quote', when: (s) => Boolean(s.quote), run: (s) => s.quote?.() },
];

/* ---------- terminal output ---------- */

/** The terminal, right-clicked, with what is selected in it. */
export type TerminalTarget = {
  selection?: string;
  quote?: (passage: string) => void;
  paste?: () => void;
  selectAll?: () => void;
  clear?: () => void;
};

/** Desktop's terminal menu, its "Attach selection as context" called Quote: Quote · Copy · Paste · Select all · Clear terminal. */
export const TERMINAL_ACTIONS: readonly Action<TerminalTarget>[] = [
  { id: 'quote', group: 'edit', label: 'Quote', icon: TextQuote, key: 'quoteSelection', when: (t) => Boolean(t.selection && t.quote), run: (t) => t.quote?.(t.selection!) },
  { id: 'copy', group: 'edit', label: 'Copy', icon: Copy, key: 'copy', when: (t) => Boolean(t.selection), run: (t) => copy(t.selection) },
  { id: 'paste', group: 'edit', label: 'Paste', icon: Clipboard, key: 'paste', when: (t) => Boolean(t.paste), run: (t) => t.paste?.() },
  { id: 'select-all', group: 'edit', label: 'Select all', icon: TextSelect, key: 'selectAll', when: (t) => Boolean(t.selectAll), run: (t) => t.selectAll?.() },
  { id: 'clear', group: 'clear', label: 'Clear terminal', icon: Eraser, when: (t) => Boolean(t.clear), run: (t) => t.clear?.() },
];

/* ---------- the message box's + ---------- */

/** What the message box's + can add: files, a command, a file or an agent to name, a shell command, and the session's MCP servers. */
export type AddTarget = {
  addFiles?: () => void;
  /** Types / in the box, for its list of commands. */
  commands?: () => void;
  /** Types @, for its list of files and agents. */
  mention?: () => void;
  /** Types !, for a shell command. */
  shell?: () => void;
  mcp?: () => void;
  /** How many of the session's MCP servers are on: "1 of 2 on". */
  mcpOn?: string;
};

/** Desktop's +, as Pelican has it: Add files or photos · Commands · Files and agents · Shell command · MCP servers. */
export const ADD_ACTIONS: readonly Action<AddTarget>[] = [
  { id: 'add-files', group: 'add', label: 'Add files or photos', icon: Paperclip, key: 'addFiles', when: (t) => Boolean(t.addFiles), run: (t) => t.addFiles?.() },
  { id: 'commands', group: 'add', label: 'Commands', icon: Slash, key: 'commands', when: (t) => Boolean(t.commands), run: (t) => t.commands?.() },
  { id: 'mention', group: 'add', label: 'Files and agents', icon: AtSign, key: 'mention', when: (t) => Boolean(t.mention), run: (t) => t.mention?.() },
  { id: 'shell', group: 'add', label: 'Shell command', icon: SquareTerminal, key: 'shell', when: (t) => Boolean(t.shell), run: (t) => t.shell?.() },
  {
    id: 'mcp', group: 'tools', label: 'MCP servers', icon: Plug, detail: (t) => t.mcpOn, opens: true,
    command: { name: '/mcp', description: 'MCP servers' },
    when: (t) => Boolean(t.mcp), run: (t) => t.mcp?.(),
  },
];

/** Every thing's list, by the thing. */
export const ACTIONS = {
  session: SESSION_ACTIONS,
  prompt: PROMPT_ACTIONS,
  reply: REPLY_ACTIONS,
  step: STEP_ACTIONS,
  path: PATH_ACTIONS,
  selection: SELECTION_ACTIONS,
  terminal: TERMINAL_ACTIONS,
  add: ADD_ACTIONS,
} as const;

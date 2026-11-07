import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Bot, FileText, Folder, Info, ListPlus, Loader2, Mic, Plus, Slash, Square, SquareTerminal, X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';

import type { StartDefaults } from '../../shared/defaults';
import { MODE_INFO, OFFERED_MODES } from '../../shared/modes';
import type { Agent, Attachment, Command, ModelOption, RunSettings, SendMode } from '../../shared/protocol';
import { ADD_ACTIONS, entries } from '../lib/actions';
import { api, apiUrl, isDemoNote } from '../lib/api';
import { type CommandItem, commandFor, commandList, filtered, GROUP_NAMES, isClaudeCommand, useCommandItems } from '../lib/commands';
import { type Held, loadDraft, removeWaiting, updateWaiting, useDraftSaver, useWaiting, whenAdded } from '../lib/drafts';
import { formatBytes } from '../lib/format';
import { ariaKeys, composing, hasKeyboard, isApple, isKey, keyText, sendsMessage } from '../lib/keyboard';
import { enterSends, usePrefs } from '../lib/prefs';
import { useMedia } from '../lib/media';
import { showPassage, sourceElement } from '../lib/passages';
import { type WaitingItem, withQuote } from '../lib/quote';
import { ActionMenu } from './ActionMenu';
import { mcpCount, useMcpServers } from './McpSheet';
import { ModelSheet, ModelSummary, ModeSheet, modelOf } from './ModelSheet';
import { ChipEditor, QuoteCard, WaitingChips } from './WaitingItems';

type Upload = { key: string; name: string; size: number; preview?: string; attachment?: Attachment; error?: string; note?: boolean };

/**
 * A touch target of about 44 px around a smaller control, so the composer keeps its looks and
 * stays easy to hit on a phone.
 */
export const HIT = 'relative after:absolute after:-inset-1';

/** Phone photos are large; send at most 2048 px on the long side. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/**
 * A composer setting, written as plain text: no fill, no border, no arrow. The send
 * button is the only solid control in the row; only a mode that skips approvals is tinted.
 */
function Chip({ children, onClick, tone = 'plain', label }: { children: React.ReactNode; onClick: () => void; tone?: 'plain' | 'warn'; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`relative flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] whitespace-nowrap after:absolute after:-inset-y-1.5 after:inset-x-0 hover:bg-hover ${tone === 'warn' ? 'text-wait' : 'text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

/** The browser's speech recognition, where there is one (Safari, Chrome; it needs HTTPS or localhost). */
const SpeechRecognition = (() => {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
})();

/** Inside another page (a frame), which decides whether the microphone may be used here. */
const framed = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
})();

/** Whether the page that holds this one lets it use the microphone (Chromium says; others do not). */
function microphoneAllowed(): boolean | undefined {
  const doc = document as unknown as { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature('microphone') : undefined;
}

const NO_SERVICE = 'This browser does not offer dictation here. Your keyboard’s microphone works too.';
const NOT_IN_FRAME = 'The page Pelican is shown in does not let it use the microphone. Open Pelican in a tab of its own to dictate.';

/** Why dictation stopped, in words; nothing for a stop that needs no explaining. */
function dictationProblem(code: string | undefined): string | undefined {
  switch (code) {
    case 'aborted':
      return undefined;
    case 'no-speech':
      return 'Nothing was heard. Tap the microphone and speak.';
    case 'not-allowed':
      return framed && microphoneAllowed() !== true ? NOT_IN_FRAME : 'The microphone is blocked for this site. Allow it in the browser’s site settings, then try again.';
    case 'service-not-allowed':
      return framed && microphoneAllowed() === false ? NOT_IN_FRAME : NO_SERVICE;
    case 'network':
      return NO_SERVICE;
    case 'audio-capture':
      return 'No microphone was found.';
    case 'language-not-supported':
      return 'Dictation does not support this language in this browser.';
    default:
      return `Dictation stopped${code ? ` (${code})` : ''}.`;
  }
}

/** What the text before the caret asks to complete: a slash command at the start, or an @ mention. */
type Trigger = { kind: 'command' | 'file'; query: string; start: number; end: number };

function findTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = before.match(/^\/([\w:.-]*)$/);
  if (command) return { kind: 'command', query: command[1]!, start: 0, end: caret };
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (mention) return { kind: 'file', query: mention[1]!, start: caret - mention[1]!.length - 1, end: caret };
  return undefined;
}

/**
 * A row of the / or @ list. `insert`: what picking it types in place of what was typed; a command
 * of Pelican's that needs no words (`item`, no `insert`) is done at once instead.
 */
type Suggestion = { key: string; label: string; detail?: string; insert: string; icon: 'command' | 'file' | 'folder' | 'agent'; group?: string; item?: CommandItem; mono?: boolean };

const ASKS_BTW = /^\/btw(?:\s|$)/;

/** `/btw`, the box's own where the chat has no list of its own: a side question, as Claude Desktop asks one. */
const BTW = (ask: (question: string) => void): CommandItem => ({
  id: 'side-chat', group: 'session', label: 'Side chat', name: 'btw', description: 'Ask in side chat', key: 'sideChat', needsWords: true, run: ask,
});

/** The / list's row for one item: its name (`/btw`, mono), or its label where it has none, and what it does. */
function commandRow(item: CommandItem): Suggestion {
  const named = Boolean(item.name);
  return {
    key: item.id,
    label: named ? `/${item.name}` : item.label,
    ...(item.description ? { detail: item.description } : {}),
    insert: named && (isClaudeCommand(item) || item.needsWords) ? `/${item.name} ` : '',
    icon: 'command',
    group: GROUP_NAMES[item.group],
    item,
    mono: named,
  };
}

function useSuggestions(trigger: Trigger | undefined, cwd: string | undefined, own: readonly CommandItem[] | undefined, device: 'pointer' | 'touch'): { items: Suggestion[]; loading: boolean; list: CommandItem[] } {
  const [fileQuery, setFileQuery] = useState('');
  useEffect(() => {
    if (trigger?.kind !== 'file') return;
    const timer = setTimeout(() => setFileQuery(trigger.query), 120);
    return () => clearTimeout(timer);
  }, [trigger?.kind, trigger?.query]);

  const completions = useQuery({
    queryKey: ['completions', cwd],
    queryFn: () => api.completions(cwd!),
    enabled: Boolean(cwd) && Boolean(trigger),
    // Claude Code finds skills as it works; a running session answers at once.
    staleTime: 60_000,
  });
  const files = useQuery({
    queryKey: ['files', cwd, fileQuery],
    queryFn: () => api.files(cwd!, fileQuery),
    enabled: Boolean(cwd) && trigger?.kind === 'file',
    staleTime: 30_000,
  });

  // Pelican's own, then Claude Code's commands and skills; one of yours takes its name from Pelican's.
  const list = useMemo(() => (own ? commandList(own, completions.data?.commands ?? [], device) : []), [own, completions.data, device]);
  return useMemo(() => {
    if (!trigger) return { items: [], loading: false, list };
    if (trigger.kind === 'command') {
      return { items: filtered(list, trigger.query).map(commandRow), loading: completions.isLoading && list.length === 0, list };
    }
    // Subagents first (`@agent-name` asks Claude to use one), then files and folders.
    const q = trigger.query.toLowerCase().replace(/^agent-/, '');
    const agents = (completions.data?.agents ?? [])
      .filter((a: Agent) => q.length > 0 ? a.name.toLowerCase().includes(q) : true)
      .slice(0, 3)
      .map((a: Agent) => ({ key: `agent:${a.name}`, label: `agent-${a.name}`, detail: a.description, insert: `@agent-${a.name} `, icon: 'agent' as const }));
    const found = (files.data ?? []).slice(0, 8 - agents.length).map((path) => ({
      key: path,
      label: path.replace(/\/$/, '').split('/').pop() + (path.endsWith('/') ? '/' : ''),
      detail: path,
      insert: `@${path}${path.endsWith('/') ? '' : ' '}`,
      icon: path.endsWith('/') ? ('folder' as const) : ('file' as const),
    }));
    return { items: [...agents, ...found], loading: files.isLoading, list };
  }, [trigger, completions.data, completions.isLoading, files.data, files.isLoading, list]);
}

/**
 * What Chat can do to the composer from outside: files dropped anywhere on the conversation,
 * keeping what is typed now, not a moment later (the chat is about to go: see lib/drafts), and
 * giving the box the keys.
 */
export type ComposerHandle = {
  addFiles: (files: FileList | File[]) => void;
  saveDraft: () => void;
  focus: () => void;
  /** Puts words in the box in place of what is there (a command picked from ⌘K), the keys with them. */
  putText: (text: string) => void;
  /**
   * Takes back words and files given to the box (a prompt a rewind put back, undone), as long as
   * the box holds those words as they were: anything typed since stays. `file`: whether a file in
   * the box is one of those given.
   */
  takeBack: (text: string, file: (attachment: Attachment) => boolean) => void;
  /** Opens the model's sheet or the mode's, as their chips do. */
  openSheet: (which: 'model' | 'mode') => void;
};

/** A finished upload as it comes back from a saved draft: the file is on the server already. */
const restored = (a: Attachment): Upload => ({
  key: a.id, name: a.name, size: a.size, attachment: a, ...(a.mime.startsWith('image/') ? { preview: apiUrl(`uploads/${encodeURIComponent(a.id)}`) } : {}),
});

/**
 * While Claude works, Send does what Settings says (While Claude works, Send) and the busy line
 * offers the other, as a button of its own: what each does, said on the line, and the button's name.
 */
const BUSY_SEND: Record<SendMode, { says: string; other: string }> = {
  steer: { says: 'Claude reads it at its next step', other: 'Queue for later' },
  queue: { says: 'Sent when this turn ends', other: 'Send now' },
};
const otherWay = (mode: SendMode): SendMode => (mode === 'steer' ? 'queue' : 'steer');

/**
 * Gives the box the keys with `put`, now or, when a sheet still on its way out holds the rest of
 * the page (the session menu, after its Side chat or Add to message), once it has gone and given
 * the keys back to what opened it.
 */
function takeKeys(box: HTMLTextAreaElement | null, put: () => void): void {
  put();
  if (box && document.activeElement !== box) {
    [...document.querySelectorAll('dialog[open]')].at(-1)?.addEventListener('close', put, { once: true });
  }
}

/**
 * Text to put in the box, a new `key` each time: a prompt to edit, a suggestion. `append` adds it
 * after what is written; `block` too, on lines of its own (a request to Claude). `back`: a message
 * that did not go, given back with its files (givenBack); what waited with it the chat gives back.
 */
export type ComposerDraft = { text: string; key: number; append?: boolean; block?: boolean; back?: boolean; attachments?: Attachment[] };

/** A `!` or `/` command: the whole box is the command, so it shares the box with nothing. */
const isCommand = (text: string) => /^\s*[!/]/.test(text);

/** What the box holds, or what comes back to it: words, and whether files go with them. */
type Content = { text: string; files: boolean };

/**
 * Where a message that did not go goes back to (its quotes go back above the box in any case):
 * into an empty box as it was, else above what is there, a blank line apart, its files beside
 * those there. A command never shares the box, with words or with files: words typed under it
 * would become part of it (its arguments, or more of the shell command), words above it would make
 * it a message, and files would go with it as a list after it. Then it, or the message that comes
 * back while one is typed, waits above the box with its files (`held`), to be put back. In a side
 * chat nothing is a command. Words the box holds already, word for word, go in once: typed again,
 * or kept as its draft while on their way and the box shown again since (a side chat reopened).
 */
function givenBack(box: Content, back: Content, commands: boolean): { text: string; held?: boolean } {
  const words = back.text.trim();
  if (!words && !back.files) return { text: box.text };
  if (words && box.text.trim() === words) return { text: box.text };
  const typed = box.text.trim().length > 0;
  if (commands && (typed || box.files) && (isCommand(back.text) || isCommand(box.text))) return { text: box.text, held: true };
  if (!words) return { text: box.text };
  return { text: typed ? `${back.text.trimEnd()}\n\n${box.text}` : back.text };
}

/**
 * Drafts a box has taken, each once. A side chat's box, closed and opened again, is a new box
 * given the same draft: it starts from what was typed in it, its draft (lib/drafts), instead.
 */
const taken = new WeakSet<ComposerDraft>();

/** How a text waiting to be put back is shown: its first line. */
const firstLine = (text: string) => text.trim().split('\n')[0]!;

/**
 * A text waiting to be put back, in a few words: its first line, and the files that go with it;
 * `name`, both, to tell its buttons from another's.
 */
function heldWords(held: Held): { words: string; files: string; name: string } {
  const names = (held.attachments ?? []).map((a) => a.name);
  const words = held.text.trim() ? firstLine(held.text) : '';
  const files = names.length > 1 ? `${names.length} files` : names[0] ?? '';
  const short = words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, '')}…` : words;
  return { words, files, name: [short, files].filter(Boolean).join(' with ') };
}

const sameHeld = (a: Held, b: Held) =>
  a.text === b.text && (a.attachments ?? []).map((f) => f.id).join('\n') === (b.attachments ?? []).map((f) => f.id).join('\n');

/** Files that come back, before those in the box already. */
const withFiles = (list: Upload[], files: Attachment[]): Upload[] => [...files.map(restored), ...list.filter((u) => !files.some((a) => a.id === u.attachment?.id))];

/**
 * While Claude works, above what you type: what Send does with it, and the other way as a button of
 * its own, a finger's 44 px on a phone, with its key faintly beside it on a computer (⌘↵, where
 * Enter sends), as Claude Desktop's Send offers Queue for later.
 */
function BusyLine({ mode, onOther }: { mode: SendMode; onOther: () => void }) {
  const { says, other } = BUSY_SEND[mode];
  const id = mode === 'steer' ? 'queue' : 'sendNow';
  const context = { enterSends: enterSends(), sendWhileBusy: mode };
  const key = hasKeyboard() ? keyText(id, isApple, context) : undefined;
  const Icon = mode === 'steer' ? ListPlus : ArrowUp;
  return (
    <div className="flex items-center gap-2 pt-1.5 pr-1.5 pl-4 text-[12.5px] leading-snug text-muted">
      <span className="min-w-0 flex-1 truncate">{says}</span>
      <button
        type="button"
        onClick={onOther}
        aria-keyshortcuts={ariaKeys(id, isApple, context)}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-chip px-3.5 text-[13.5px] text-fg hover:bg-hover pointer-fine:h-8 pointer-fine:px-3 pointer-fine:text-[13px]"
      >
        <Icon className="size-4 shrink-0 text-muted" />
        {other}
        {key && <span className="text-[12px] text-faint">{key}</span>}
      </button>
    </div>
  );
}

export function Composer({
  busy,
  settings,
  onSettings,
  models,
  onSend,
  onShell,
  onStop,
  stopping,
  placeholder = 'Message Claude',
  autoFocus,
  cwd,
  draft,
  draftKey,
  trailing,
  disabled,
  onSideChat,
  onShowItem,
  side = false,
  atBottom = true,
  defaults,
  sheetNotes,
  mcpSession,
  onMcp,
  onCommandMenu,
  ref,
}: {
  busy: boolean;
  settings: RunSettings;
  onSettings: (settings: RunSettings) => void;
  models: ModelOption[] | undefined;
  /** Claude Code's settings for new sessions here: a model picked in the sheet takes its effort from them. */
  defaults?: StartDefaults;
  /** Small print for the model and mode sheets: where values come from, what a pick saves, what went wrong. */
  sheetNotes?: { model?: ReactNode; modelFooter?: ReactNode; mode?: ReactNode };
  onSend: (text: string, attachments: Attachment[], mode: SendMode) => void;
  /** Runs a `!` command in the session's folder; without it, `!` is ordinary text. */
  onShell?: (command: string) => void;
  onStop: () => void;
  /** Stop was asked for and the turn is ending. */
  stopping?: boolean;
  /** What the empty box says while Claude is idle; while it works, the box says where a message goes. */
  placeholder?: string;
  autoFocus?: boolean;
  /** Folder of the session, for / commands and @ files. */
  cwd?: string;
  draft?: ComposerDraft;
  /** Where what is typed is kept until it is sent (lib/drafts): the chat's view id. */
  draftKey?: string;
  /** Shown before Send and Stop: the context meter, on a phone. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** `/btw`, with a question or without: opens the session's side chat instead of sending; the quotes go with it. */
  onSideChat?: (question: string) => void;
  /** Shows where a comment or a file that waits is: Changes or Files. Quotes from the conversation it shows itself. */
  onShowItem?: (item: WaitingItem) => void;
  /** A side chat's own box: questions only, without files, settings, `!` or `/` commands. */
  side?: boolean;
  /** At the foot of the screen, clear of a phone's or a tablet's home indicator; a sheet keeps clear of it itself. */
  atBottom?: boolean;
  /** The session whose MCP servers + counts, and opens (`onMcp`). */
  mcpSession?: string;
  onMcp?: () => void;
  /** The command menu, for + › Commands while the box holds words. */
  onCommandMenu?: () => void;
  ref?: Ref<ComposerHandle>;
}) {
  // The box starts from what was typed in it; a draft it is given goes in once it is up (taken).
  const [saved] = useState(() => (draftKey ? loadDraft(draftKey) : undefined));
  const [text, setText] = useState(saved?.text ?? '');
  const [caret, setCaret] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>(() => (saved?.attachments ?? []).map(restored));
  // What waits to go with the next message (lib/drafts): quotes, comments, files. Chat takes it when
  // a message goes; a phone shows the quote just taken as a card, to add a note to.
  const items = useWaiting(draftKey);
  const touch = !useMedia('(hover: hover) and (pointer: fine)');
  const [carded, setCarded] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; chip: HTMLElement | null }>();
  const frame = useRef<HTMLDivElement>(null);
  // What came back from a send that failed but could not share the box (givenBack), files and all.
  const [held, setHeld] = useState<Held[]>(() => saved?.held ?? []);
  const [sheet, setSheet] = useState<'model' | 'mode' | undefined>();
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState<{ keys: boolean }>();
  const chips = useRef<HTMLUListElement>(null);
  const card = carded && touch ? items.find((item) => item.id === carded) : undefined;
  const opened = editing ? items.find((item) => item.id === editing.id) : undefined;
  const listId = useId();
  const listBox = useRef<HTMLDivElement>(null);

  const model = modelOf(models, settings);
  const permission = settings.permissionMode ?? 'default';
  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const canSend = !disabled && (text.trim().length > 0 || uploads.some((u) => u.attachment) || items.length > 0) && !uploading;

  // What is typed is kept per chat until it is sent; a send that fails gives it back as it was.
  const draftSaver = useDraftSaver(draftKey);
  const justSent = useRef(false);
  useEffect(() => {
    if (justSent.current) {
      justSent.current = false;
      return;
    }
    draftSaver.save(text, uploads.flatMap((u) => (u.attachment ? [u.attachment] : [])), held);
  }, [text, uploads, held, draftSaver]);

  // A quote taken anywhere in this chat (a reply, a step, a file) comes here. On a computer the box
  // takes the keys, to say what about it; a phone keeps its keyboard down, the quote waiting as a
  // card with "Add a note" (a side chat's question is its note), so more can be quoted first.
  useEffect(() => {
    if (!draftKey) return undefined;
    return whenAdded(draftKey, (item) => {
      if (hasKeyboard()) requestAnimationFrame(() => area.current?.focus({ preventScroll: true }));
      else if (item.kind === 'quote' && !side) setCarded(item.id);
    });
  }, [draftKey, side]);
  // Gone (sent, removed), it takes its card and its editor with it.
  useEffect(() => {
    if (carded && !items.some((item) => item.id === carded)) setCarded(undefined);
    if (editing && !items.some((item) => item.id === editing.id)) setEditing(undefined);
  }, [items, carded, editing]);

  const trigger = useMemo(() => {
    const found = findTrigger(text, caret);
    // A side chat takes questions: no / commands there.
    if (side && found?.kind === 'command') return undefined;
    return found && `${found.kind}:${found.start}` !== dismissed ? found : undefined;
  }, [text, caret, dismissed, side]);
  // The page's and the chat's commands, by name, for the main box; a side chat's takes questions only.
  const registered = useCommandItems();
  const asks = useRef(onSideChat);
  asks.current = onSideChat;
  const ownBtw = useMemo(() => BTW((question) => asks.current?.(question)), []);
  const own = useMemo(() => {
    if (side) return undefined;
    return onSideChat && !registered.some((item) => item.name === 'btw') ? [ownBtw, ...registered] : registered;
  }, [side, registered, onSideChat, ownBtw]);
  const device = touch ? 'touch' : 'pointer';
  const { items: suggestions, loading: suggesting, list: commands } = useSuggestions(trigger, cwd, own, device);
  const showSuggestions = Boolean(trigger) && (suggestions.length > 0 || suggesting);

  useEffect(() => setHighlight(0), [trigger?.kind, trigger?.query]);
  useEffect(() => {
    listBox.current?.querySelector(`[id="${listId}-${highlight}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, listId]);

  useEffect(() => {
    if (!draft || taken.has(draft)) return;
    taken.add(draft);
    // What waited with a message given back is above the box again already: the chat gives it back.
    const files = draft.attachments ?? [];
    const back = draft.back ? givenBack({ text, files: uploads.some((u) => !u.error) }, { text: draft.text, files: files.length > 0 }, !side) : undefined;
    const next = draft.block ? withQuote(text, draft.text)
      : draft.append ? `${text}${text && !/\s$/.test(text) ? ' ' : ''}${draft.text}`
        : back ? back.text
          : draft.text;
    setText(next);
    // Its files come back too: waiting with its words, or beside any added since.
    if (back?.held) {
      const waiting: Held = { text: draft.text, ...(files.length > 0 ? { attachments: files } : {}) };
      setHeld((list) => (list.some((h) => sameHeld(h, waiting)) ? list : [...list, waiting]));
    } else if (files.length > 0) {
      setUploads((list) => withFiles(list, files));
    }
    const put = () => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    };
    requestAnimationFrame(() => takeKeys(area.current, put));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.key]);

  // While Claude works, Send sends now (Claude reads it at its next step) or queues it for after
  // this turn, as Settings says; the busy line's button, and ⌘↵ where Enter sends, does the other.
  const { sendWhileBusy: mode } = usePrefs();
  const shell = Boolean(onShell) && !side && text.startsWith('!');

  // Dictation: what you say goes into the box, to read over before sending.
  const [listening, setListening] = useState(false);
  const [dictationError, setDictationError] = useState<string>();
  const recognition = useRef<Recognition | undefined>(undefined);
  useEffect(() => {
    if (!dictationError) return undefined;
    const timer = setTimeout(() => setDictationError(undefined), 8000);
    return () => clearTimeout(timer);
  }, [dictationError]);
  const dictate = () => {
    setDictationError(undefined);
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!SpeechRecognition) return;
    // The page holding this one has not let it use the microphone: say so instead of failing quietly.
    if (microphoneAllowed() === false) {
      setDictationError(framed ? NOT_IN_FRAME : 'The microphone is blocked for this site.');
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    const before = text;
    rec.onresult = (event) => {
      let said = '';
      for (let i = 0; i < event.results.length; i += 1) said += event.results[i]![0]!.transcript;
      setText(`${before}${before && !/\s$/.test(before) ? ' ' : ''}${said.trimStart()}`);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (event) => {
      setListening(false);
      setDictationError(dictationProblem(event?.error));
    };
    try {
      rec.start();
      recognition.current = rec;
      setListening(true);
    } catch (error) {
      setListening(false);
      setDictationError(dictationProblem((error as { name?: string })?.name === 'NotAllowedError' ? 'not-allowed' : undefined));
    }
  };
  useEffect(() => () => recognition.current?.stop(), []);

  // A side chat's box asks for a question whatever its Claude is doing.
  const hint = busy && !shell && !side ? (mode === 'steer' ? 'Tell Claude while it works' : 'Queue a message for after this turn') : placeholder;
  // The busy line: while Claude works and there is something to send, what Send does and the other way.
  const busyLine = busy && canSend && !shell && !side;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    // Empty, the box is as tall as what it says: a hint that takes two lines on a phone shows whole.
    let height = el.scrollHeight;
    if (!el.value && hint) {
      el.value = hint;
      height = el.scrollHeight;
      el.value = '';
    }
    el.style.height = `${Math.min(height, Math.round(window.innerHeight * 0.4))}px`;
  }, [text, hint]);

  // On a phone too: a new session opens ready to type, with the keyboard up where the browser
  // lets a page raise it. A side chat opened from the session menu has the keys once the menu has gone.
  // A note being written at a quote for this box (Quotes' note box, back with its chat) keeps them;
  // one written in another chat does not: the side chat opened meanwhile takes the keys.
  useEffect(() => {
    const noting = [...document.querySelectorAll('[data-note-box]')].some((box) => box.getAttribute('data-note-box') === draftKey);
    if (autoFocus && !noting) takeKeys(area.current, () => area.current?.focus());
  }, [autoFocus]);

  const addFiles = (files: FileList | File[]) => {
    for (const original of Array.from(files)) {
      const key = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
      const preview = original.type.startsWith('image/') ? URL.createObjectURL(original) : undefined;
      setUploads((list) => [...list, { key, name: original.name, size: original.size, ...(preview ? { preview } : {}) }]);
      void shrinkImage(original)
        .then((file) => api.upload(file))
        .then((attachment) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, attachment, size: attachment.size } : u))))
        .catch((error: Error) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, error: error.message, note: isDemoNote(error) } : u))));
    }
  };
  useImperativeHandle(ref, () => ({
    addFiles,
    saveDraft: () => draftSaver.now(text, uploads.flatMap((u) => (u.attachment ? [u.attachment] : [])), held),
    focus: () => area.current?.focus({ preventScroll: true }),
    putText: (next: string) => {
      setText(next);
      setCaret(next.length);
      setDismissed(undefined);
      requestAnimationFrame(() => takeKeys(area.current, () => {
        area.current?.focus();
        area.current?.setSelectionRange(next.length, next.length);
      }));
    },
    openSheet: (which: 'model' | 'mode') => setSheet(which),
    takeBack: (back: string, file: (attachment: Attachment) => boolean) => {
      if (text.trim() !== back.trim()) return;
      setText('');
      setCaret(0);
      setUploads((list) => list.filter((u) => {
        const taken = Boolean(u.attachment && file(u.attachment));
        if (taken) forget(u);
        return !taken;
      }));
    },
  }));

  const forget = (u: Upload) => {
    if (u.preview?.startsWith('blob:')) URL.revokeObjectURL(u.preview);
  };

  /**
   * Something that waited, taken away. With the keys (or on a computer) they go on to the next
   * chip, else to the box; a tap on a phone leaves them, so its keyboard stays down.
   */
  const remove = (item: WaitingItem, byKeys: boolean) => {
    if (!draftKey) return;
    const at = items.filter((i) => i.id !== carded).findIndex((i) => i.id === item.id);
    removeWaiting(draftKey, item.id);
    if (!byKeys && !hasKeyboard()) return;
    requestAnimationFrame(() => (chips.current?.querySelectorAll<HTMLElement>('li')[at]?.querySelector('button') ?? area.current)?.focus({ preventScroll: true }));
  };
  /** Shows where a waiting item came from (its editor has gone): the passage in the conversation, marked, or a comment or file in Changes or Files. */
  const showItem = (item: WaitingItem) => {
    if (item.kind === 'quote' && !item.path) requestAnimationFrame(() => showPassage(item.from));
    else onShowItem?.(item);
  };
  const canShow = (item: WaitingItem) => (item.kind === 'quote' && !item.path ? Boolean(sourceElement(item.from.key)) : Boolean(onShowItem));

  /**
   * Puts a text that waited back in the box, its files with it, by the rule it came back by: above
   * what is typed, or, where one of the two is a command, in its place, what was in the box, words
   * and files, waiting where it was, set aside. A file still on its way waits for Put back, as it
   * does for Send.
   */
  const putBack = (at: number) => {
    const back = held[at];
    if (back === undefined || uploading) return;
    const files = back.attachments ?? [];
    const joined = givenBack({ text, files: uploads.some((u) => !u.error) }, { text: back.text, files: files.length > 0 }, !side);
    const next = joined.held ? back.text : joined.text;
    if (joined.held) {
      const attached = uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
      const aside: Held = { text, ...(attached.length > 0 ? { attachments: attached } : {}), aside: true };
      for (const u of uploads) if (u.attachment) forget(u);
      setHeld((list) => list.map((h, i) => (i === at ? aside : h)));
      setUploads((list) => [...files.map(restored), ...list.filter((u) => !u.attachment)]);
    } else {
      setHeld((list) => list.filter((_, i) => i !== at));
      if (files.length > 0) setUploads((list) => withFiles(list, files));
    }
    setText(next);
    requestAnimationFrame(() => {
      const el = area.current;
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  };
  const discard = (at: number, byKeys: boolean) => {
    setHeld((list) => list.filter((_, i) => i !== at));
    if (byKeys || hasKeyboard()) requestAnimationFrame(() => area.current?.focus({ preventScroll: true }));
  };

  /** Sends what the box holds; while Claude works, as Send does (`how`: the busy line's other way). */
  const submit = (how: SendMode = mode) => {
    if (!canSend) return;
    if (shell) {
      const command = text.slice(1).trim();
      if (!command) return;
      // What waits stays for the next message: a command is not about it.
      draftSaver.now(`!${command}`, [], held);
      onShell!(command);
      justSent.current = true;
      setText('');
      setCaret(0);
      return;
    }
    recognition.current?.stop();
    // /btw asks in the side chat, with the quotes; what goes with this session stays here.
    if (onSideChat && ASKS_BTW.test(text.trim())) {
      onSideChat(text.trim().replace(ASKS_BTW, '').trim());
      setText('');
      setCaret(0);
      return;
    }
    // One of Pelican's, by Claude Code's name (/rename, /export, /diff…): done here, not sent.
    const asked = side ? undefined : commandFor(text, commands);
    if (asked) {
      draftSaver.now('', [], held);
      justSent.current = true;
      setText('');
      setCaret(0);
      asked.item.run(asked.words);
      return;
    }
    // Typed out of habit in a side chat, /btw only says what the rest is.
    const words = side ? text.trim().replace(ASKS_BTW, '').trim() : text.trim();
    if (!words && items.length === 0 && !uploads.some((u) => u.attachment)) return;
    // A / command has to start its message, and takes nothing but its words: what waits and the
    // files wait for the next message, as with a ! command (files would go to it as its arguments).
    // What waits goes with the words otherwise: the chat takes it as the message goes.
    const command = words.startsWith('/');
    const attachments = command ? [] : uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
    draftSaver.now(words, attachments, held);
    onSend(words, attachments, how);
    justSent.current = true;
    setText('');
    setCaret(0);
    if (command) return;
    setCarded(undefined);
    for (const u of uploads) forget(u);
    setUploads([]);
  };

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    // One of Pelican's that needs no words is done at once, and what was typed for it goes.
    const now = suggestion.item && !suggestion.insert ? suggestion.item : undefined;
    const next = text.slice(0, trigger.start) + suggestion.insert + text.slice(trigger.end);
    if (now) {
      setText(next);
      setCaret(trigger.start);
      now.run('');
      return;
    }
    const at = trigger.start + suggestion.insert.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys an input method takes are its own (the Enter that picks a word, the Esc that cancels
    // one, the arrows through its list), not the / and @ list's or the box's.
    if (composing(e.nativeEvent)) return;
    // ⌘/Ctrl+Enter sends whatever the Enter key setting, list open or not; while Claude works, where
    // Enter sends, it is the busy line's other way (Queue for later, or Send now), as in Desktop.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(busyLine && enterSends() ? otherWay(mode) : mode);
      return;
    }
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(suggestions[highlight] ?? suggestions[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (trigger) setDismissed(`${trigger.kind}:${trigger.start}`);
        return;
      }
    }
    if (sendsMessage(e.nativeEvent, enterSends())) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    // A side question goes without files; a pasted one stays out of it.
    if (side) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  /**
   * Puts a character that opens one of the box's lists (/ for commands, @ for files and agents, !
   * for a shell command) where it starts one, and gives the box the keys: / and ! begin the box,
   * @ goes at the caret, after a space.
   */
  const typeIn = (mark: '/' | '@' | '!') => {
    const el = area.current;
    const at = el ? el.selectionStart : text.length;
    let next: string;
    let caretAt: number;
    if (mark === '@') {
      const before = text.slice(0, at);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      next = `${before}${lead}@${text.slice(at)}`;
      caretAt = before.length + lead.length + 1;
    } else {
      next = `${mark}${text.replace(/^[!/]/, '')}`;
      caretAt = mark === '/' ? 1 : next.length;
    }
    setText(next);
    setCaret(caretAt);
    setDismissed(undefined);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caretAt, caretAt);
    });
  };
  const mcp = useMcpServers(mcpSession, Boolean(adding));
  const addEntries = side ? [] : entries(ADD_ACTIONS, {
    addFiles: () => picker.current?.click(),
    // With words in the box, the command menu; an empty box takes the / and lists them above it.
    commands: () => (text.trim() && onCommandMenu ? onCommandMenu() : typeIn('/')),
    mention: () => typeIn('@'),
    ...(onShell ? { shell: () => typeIn('!') } : {}),
    ...(onMcp && mcpSession ? { mcp: onMcp } : {}),
    ...(mcpCount(mcp.data?.servers) ? { mcpOn: mcpCount(mcp.data?.servers) } : {}),
  }, 'menu', touch ? 'touch' : 'pointer');

  // Desktop's keys for the box's own controls, in the session's box (not a side chat's), while
  // no sheet is open: ⌘U adds files, ⇧⌘I the model, ⇧⌘E its effort, ⌥⌘F fast mode, ⌥⌘M the mode.
  const keyed = useRef({ settings, models, onSettings });
  keyed.current = { settings, models, onSettings };
  useEffect(() => {
    if (side || disabled) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented || composing(e) || document.querySelector('dialog[open]:not([data-closing])')) return;
      const { settings: now, models: offered, onSettings: change } = keyed.current;
      if (isKey(e, 'addFiles')) picker.current?.click();
      else if (isKey(e, 'model') || isKey(e, 'effort')) setSheet('model');
      else if (isKey(e, 'mode')) setSheet('mode');
      else if (isKey(e, 'fastMode')) {
        if (!modelOf(offered, now)?.supportsFast) return;
        change({ ...now, fast: !now.fast });
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [side, disabled]);

  const set = (patch: Partial<RunSettings>) => onSettings({ ...settings, ...patch });
  const failed = uploads.filter((u) => u.error);
  const problems = [...new Set(failed.filter((u) => !u.note).map((u) => u.error!))];
  const notes = [...new Set(failed.filter((u) => u.note).map((u) => u.error!))];
  const listOpen = showSuggestions && suggestions.length > 0;

  return (
    // In a very short window the chat scrolls as a whole; the composer stays at the bottom of it.
    <div ref={frame} data-composer className={`${atBottom ? 'pb-safe' : 'pb-2'} relative shrink-0 px-3 pt-1 [@media(max-height:380px)]:sticky [@media(max-height:380px)]:bottom-0 [@media(max-height:380px)]:z-10 [@media(max-height:380px)]:bg-bg`}>
      {showSuggestions && (
        <div
          id={listId}
          ref={listBox}
          role="listbox"
          aria-label={trigger?.kind === 'command' ? 'Commands' : 'Files and agents'}
          className="animate-fade absolute right-3 bottom-full left-3 z-20 mx-auto mb-1 max-h-[min(60dvh,26rem)] max-w-3xl overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel py-1 shadow-xl"
        >
          {suggesting && suggestions.length === 0 && <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-faint" /></div>}
          {suggestions.map((s, i) => {
            const Icon = s.item?.icon ?? (s.icon === 'command' ? Slash : s.icon === 'folder' ? Folder : s.icon === 'agent' ? Bot : FileText);
            const heading = s.group && s.group !== suggestions[i - 1]?.group ? s.group : undefined;
            return (
              <div key={s.key} role="presentation">
                {heading && <div role="presentation" className="px-3 pt-2 pb-1 text-[12px] text-faint">{heading}</div>}
                <button
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === highlight}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => accept(s)}
                  className={`flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left pointer-fine:min-h-9 ${i === highlight ? 'bg-hover' : ''}`}
                >
                  <Icon className="size-3.5 shrink-0 text-faint" />
                  <span className={`shrink-0 ${s.mono === false ? 'text-[14px]' : 'font-mono text-[13px]'}`}>{s.label}</span>
                  {s.detail && <span className="min-w-0 truncate text-[12.5px] text-faint">{s.detail}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="mx-auto max-w-3xl rounded-[22px] border border-line bg-panel shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        <WaitingChips
          list={chips}
          items={card ? items.filter((item) => item.id !== card.id) : items}
          touch={touch}
          {...(editing ? { open: editing.id } : {})}
          onOpen={(item, chip) => setEditing((was) => (was?.id === item.id ? undefined : { id: item.id, chip }))}
          onRemove={remove}
        />
        {card && draftKey && (
          <QuoteCard
            key={card.id}
            item={card}
            onNote={(note) => updateWaiting(draftKey, card.id, { note })}
            onRemove={() => remove(card, false)}
          />
        )}
        {uploads.length > 0 && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 pt-3">
            {uploads.map((u) => (
              <div key={u.key} className="relative shrink-0">
                <div className={u.error ? 'opacity-40' : ''}>
                  {u.preview ? (
                    <img alt={u.name} src={u.preview} className="size-16 rounded-xl border border-line object-cover" />
                  ) : (
                    <div className="flex h-16 w-36 flex-col justify-center gap-0.5 rounded-xl border border-line px-2.5">
                      <div className="flex items-center gap-1.5 text-[12.5px]"><FileText className="size-3.5 shrink-0" /><span className="truncate">{u.name}</span></div>
                      <div className="text-[11px] text-faint">{formatBytes(u.size)}</div>
                    </div>
                  )}
                </div>
                {!u.attachment && !u.error && <div className="absolute inset-0 grid place-items-center rounded-xl bg-panel/60"><Loader2 className="size-4 animate-spin" /></div>}
                {u.error && !u.note && <span aria-hidden className="absolute bottom-1 left-1 grid size-4 place-items-center rounded-full bg-danger text-[11px] leading-none font-semibold text-white">!</span>}
                <button
                  type="button"
                  aria-label={`Remove ${u.name}`}
                  className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-fg text-bg after:absolute after:-inset-3"
                  onClick={() => {
                    forget(u);
                    setUploads((list) => list.filter((x) => x.key !== u.key));
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {problems.length > 0 && <div className="px-4 pt-2 text-[12.5px] leading-snug text-danger">{problems.join(' · ')}</div>}
        {notes.length > 0 && <div className="flex items-start gap-1.5 px-4 pt-2 text-[12.5px] leading-snug text-muted"><Info className="mt-px size-3.5 shrink-0" />{notes.join(' · ')}</div>}
        {held.map((h, i) => {
          const { words, files, name: said } = heldWords(h);
          // Two that begin alike are told apart by where they are in the list.
          const name = held.filter((other) => heldWords(other).name === said).length > 1 ? `${said} (${i + 1} of ${held.length})` : said;
          return (
            <div key={`${i}:${h.text}:${files}`} role="status" className="flex items-center gap-1 pt-2 pr-2 pl-4 text-[12.5px] leading-snug text-muted">
              {/* Long words are cut before the files that wait with them. */}
              <span title={[h.text.trim(), ...(h.attachments ?? []).map((a) => a.name)].filter(Boolean).join('\n')} className="flex min-w-0 flex-1 items-baseline gap-1 whitespace-nowrap">
                {h.aside ? 'Set aside: ' : 'Not sent: '}
                <span className={`min-w-0 truncate text-fg ${words && isCommand(h.text) ? 'font-mono text-[12px]' : ''}`}>{words || files}</span>
                {/* The files give way first: a long name never cuts the words to a few letters. */}
                {words && files && <span className="max-w-[35%] min-w-0 shrink-[4] truncate text-faint">{' · '}{files}</span>}
              </span>
              <button type="button" aria-label={`Put back ${name}`} disabled={uploading} onClick={() => putBack(i)} className="relative h-7 shrink-0 rounded-full px-2 font-medium text-fg after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover disabled:opacity-40">
                Put back
              </button>
              <button type="button" aria-label={`Discard ${name}`} onClick={(e) => discard(i, e.detail === 0)} className="relative grid size-7 shrink-0 place-items-center rounded-full text-faint after:absolute after:-inset-2 hover:bg-hover hover:text-fg">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        {dictationError && <div role="status" className="px-4 pt-2.5 text-[12.5px] leading-snug text-danger">{dictationError}</div>}
        {busyLine && <BusyLine mode={mode} onOther={() => submit(otherWay(mode))} />}
        <textarea
          ref={area}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={hint}
          aria-label={side ? 'Side question' : 'Message Claude'}
          aria-autocomplete={showSuggestions ? 'list' : undefined}
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={listOpen ? `${listId}-${Math.min(highlight, suggestions.length - 1)}` : undefined}
          onChange={(e) => {
            setDictationError(undefined);
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(undefined);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          className={`block max-h-[40dvh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-6 outline-none placeholder:text-faint disabled:opacity-50 ${shell ? 'font-mono' : ''}`}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {!side && (
            <>
              <button
                ref={plus}
                type="button"
                aria-label="Add"
                aria-haspopup="menu"
                aria-expanded={Boolean(adding)}
                className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg ${adding ? 'bg-hover text-fg' : ''}`}
                onClick={(e) => setAdding({ keys: e.detail === 0 })}
              >
                <Plus className="size-[19px]" />
              </button>
              <input ref={picker} type="file" multiple hidden onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }} />
            </>
          )}
          {/* Model, effort and speed share one chip, so the row fits a phone; it scrolls with a fade if not,
              with room above and below for the chips' touch area, which the scrolling would clip. A
              side chat runs with the session's, and changes nothing, in a mode of its own. */}
          {side ? <div className="min-w-0 flex-1" /> : shell ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-[12.5px] text-muted">
              <SquareTerminal className="size-3.5 shrink-0" />
              <span className="truncate">Shell command</span>
            </div>
          ) : (
          <div className="no-scrollbar -my-1.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5 pr-3 [mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]">
            <Chip label="Model, effort and speed" onClick={() => setSheet('model')}>
              <ModelSummary settings={settings} models={models} />
            </Chip>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-line" />
            <Chip label="Permission mode" tone={permission === 'bypassPermissions' ? 'warn' : 'plain'} onClick={() => setSheet('mode')}>
              {MODE_INFO[permission].short}
            </Chip>
          </div>
          )}
          {trailing}
          {/* Stop while Claude works, always: beside Send once there is something to send, quiet, as Send is the one to press then. */}
          {busy && (
            <button
              type="button"
              aria-label={stopping ? 'Stopping' : 'Stop'}
              title="Stop (Esc)"
              aria-keyshortcuts="Escape"
              disabled={stopping}
              onClick={onStop}
              className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full disabled:opacity-40 ${canSend ? 'bg-chip text-fg hover:bg-hover' : 'bg-fg text-bg'}`}
            >
              {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
            </button>
          )}
          {listening || (!busy && !canSend && !uploading && SpeechRecognition && !disabled) ? (
            <button
              type="button"
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              onClick={dictate}
              className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full transition-colors ${listening ? 'bg-danger text-white' : 'text-muted hover:bg-hover hover:text-fg'}`}
            >
              {listening ? <span className="relative flex size-3"><span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" /><Square className="relative size-3 fill-current" /></span> : <Mic className="size-[18px]" />}
            </button>
          ) : busy && !canSend ? null : (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => submit()}
              className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full bg-fg text-bg transition-opacity disabled:opacity-25`}
            >
              {shell ? <SquareTerminal className="size-[17px]" /> : <ArrowUp className="size-[18px]" />}
            </button>
          )}
        </div>
      </div>

      {opened && draftKey && (
        <ChipEditor
          key={opened.id}
          item={opened}
          touch={touch}
          anchor={editing?.chip ?? null}
          frame={frame.current}
          canShow={canShow(opened)}
          onNote={(note) => updateWaiting(draftKey, opened.id, { note })}
          onShow={() => showItem(opened)}
          onRemove={() => remove(opened, false)}
          onClose={(how) => {
            const chip = editing?.chip;
            setEditing(undefined);
            // Closed from inside on a computer, the keys go back to its chip, or to the box once that has gone.
            if (how === 'done' && !touch) requestAnimationFrame(() => ((chip?.isConnected ? chip.querySelector('button') : null) ?? area.current)?.focus({ preventScroll: true }));
          }}
        />
      )}
      {!side && (
        <>
          <ActionMenu open={Boolean(adding)} onClose={() => setAdding(undefined)} label="Add" entries={addEntries} at={plus.current} focusFirst={Boolean(adding?.keys)} />
          <ModelSheet
            open={sheet === 'model'}
            onClose={() => setSheet(undefined)}
            settings={settings}
            models={models}
            onChange={onSettings}
            {...(defaults ? { defaults } : {})}
            note={sheetNotes?.model}
            footer={sheetNotes?.modelFooter}
          />
          <ModeSheet open={sheet === 'mode'} onClose={() => setSheet(undefined)} offered={OFFERED_MODES} value={permission} model={model} onPick={(m) => set({ permissionMode: m })} note={sheetNotes?.mode} />
        </>
      )}
    </div>
  );
}

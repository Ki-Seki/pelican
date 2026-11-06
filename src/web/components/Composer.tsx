import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Bot, FileText, Folder, Info, Loader2, Mic, Paperclip, Quote, Slash, Square, SquareTerminal, X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { MODE_INFO, OFFERED_MODES } from '../../shared/modes';
import type { Agent, Attachment, Command, ModelOption, RunSettings, SendMode } from '../../shared/protocol';
import { api, apiUrl, isDemoNote } from '../lib/api';
import { type Held, loadDraft, useDraftSaver } from '../lib/drafts';
import { formatBytes } from '../lib/format';
import { composing, hasKeyboard, sendsMessage } from '../lib/keyboard';
import { enterSends, getPrefs } from '../lib/prefs';
import { messageWithQuotes, quoteLabel, receiveQuotes, splitQuotes, withQuote } from '../lib/quote';
import { ModelSheet, ModelSummary, ModeSheet, modelOf } from './ModelSheet';

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

type Suggestion = { key: string; label: string; detail?: string; insert: string; icon: 'command' | 'file' | 'folder' | 'agent' };

/** `/btw`: a side question, which Pelican opens as Claude Desktop does (a side chat), not a command Claude Code runs. */
const BTW: Command = { name: 'btw', description: 'Ask a side question; this session stays as it is', argumentHint: '<question>' };
const ASKS_BTW = /^\/btw(?:\s|$)/;

function useSuggestions(trigger: Trigger | undefined, cwd: string | undefined, own: Command[]): { items: Suggestion[]; loading: boolean } {
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

  return useMemo(() => {
    if (!trigger) return { items: [], loading: false };
    if (trigger.kind === 'command') {
      const q = trigger.query.toLowerCase();
      const list = [...own, ...(completions.data?.commands ?? []).filter((c: Command) => !own.some((o) => o.name === c.name))]
        .filter((c: Command) => !q || c.name.toLowerCase().includes(q))
        .sort((a: Command, b: Command) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((c: Command) => ({ key: c.name, label: `/${c.name}`, detail: c.argumentHint ? `${c.argumentHint} · ${c.description}` : c.description, insert: `/${c.name} `, icon: 'command' as const }));
      return { items: list, loading: completions.isLoading };
    }
    // Subagents first (`@agent-name` asks Claude to use one), then files and folders.
    const q = trigger.query.toLowerCase().replace(/^agent-/, '');
    const agents = (completions.data?.agents ?? [])
      .filter((a: Agent) => q.length > 0 ? a.name.toLowerCase().includes(q) : true)
      .slice(0, 3)
      .map((a: Agent) => ({ key: `agent:${a.name}`, label: `agent-${a.name}`, detail: a.description, insert: `@agent-${a.name} `, icon: 'agent' as const }));
    const list = (files.data ?? []).slice(0, 8 - agents.length).map((path) => ({
      key: path,
      label: path.replace(/\/$/, '').split('/').pop() + (path.endsWith('/') ? '/' : ''),
      detail: path,
      insert: `@${path}${path.endsWith('/') ? '' : ' '}`,
      icon: path.endsWith('/') ? ('folder' as const) : ('file' as const),
    }));
    return { items: [...agents, ...list], loading: files.isLoading };
  }, [trigger, completions.data, completions.isLoading, files.data, files.isLoading, own]);
}

/**
 * What Chat can do to the composer from outside: files dropped anywhere on the conversation,
 * keeping what is typed now, not a moment later (the chat is about to go: see lib/drafts), and
 * giving the box the keys.
 */
export type ComposerHandle = { addFiles: (files: FileList | File[]) => void; saveDraft: () => void; focus: () => void };

/** A finished upload as it comes back from a saved draft: the file is on the server already. */
const restored = (a: Attachment): Upload => ({
  key: a.id, name: a.name, size: a.size, attachment: a, ...(a.mime.startsWith('image/') ? { preview: apiUrl(`uploads/${encodeURIComponent(a.id)}`) } : {}),
});

const MODE_HINT: Record<SendMode, string> = { steer: 'Claude reads it at its next step', queue: 'Sent when this turn ends' };

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
 * that did not go, given back with its quotes and files (givenBack).
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
  side = false,
  atBottom = true,
  ref,
}: {
  busy: boolean;
  settings: RunSettings;
  onSettings: (settings: RunSettings) => void;
  models: ModelOption[] | undefined;
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
  /** `/btw`, with a question or without: opens the session's side chat instead of sending. */
  onSideChat?: (question: string) => void;
  /** A side chat's own box: questions only, without files, settings, `!` or `/` commands. */
  side?: boolean;
  /** At the foot of the screen, clear of a phone's or a tablet's home indicator; a sheet keeps clear of it itself. */
  atBottom?: boolean;
  ref?: Ref<ComposerHandle>;
}) {
  // The box starts from what was typed in it; a draft it is given goes in once it is up (taken).
  const [saved] = useState(() => (draftKey ? loadDraft(draftKey) : undefined));
  const [text, setText] = useState(saved?.text ?? '');
  const [caret, setCaret] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>(() => (saved?.attachments ?? []).map(restored));
  // Quotes of what was selected (lib/quote), above the box until they go above the words.
  const [quotes, setQuotes] = useState<string[]>(() => saved?.quotes ?? []);
  // What came back from a send that failed but could not share the box (givenBack), files and all.
  const [held, setHeld] = useState<Held[]>(() => saved?.held ?? []);
  const [sheet, setSheet] = useState<'model' | 'mode' | undefined>();
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const chips = useRef<HTMLUListElement>(null);
  const listId = useId();

  const model = modelOf(models, settings);
  const permission = settings.permissionMode ?? 'default';
  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const canSend = !disabled && (text.trim().length > 0 || uploads.some((u) => u.attachment) || quotes.length > 0) && !uploading;

  // What is typed is kept per chat until it is sent; a send that fails gives it back as it was.
  const draftSaver = useDraftSaver(draftKey);
  const justSent = useRef(false);
  useEffect(() => {
    if (justSent.current) {
      justSent.current = false;
      return;
    }
    draftSaver.save(text, uploads.flatMap((u) => (u.attachment ? [u.attachment] : [])), quotes, held);
  }, [text, uploads, quotes, held, draftSaver]);

  // A quote made anywhere in this chat (a reply, a file) comes here. On a computer the box takes
  // the keys, to say what about it; a phone keeps its keyboard down, so more can be quoted first.
  useEffect(() => {
    if (!draftKey) return undefined;
    return receiveQuotes(draftKey, (quote) => {
      setQuotes((list) => (list.includes(quote) ? list : [...list, quote]));
      if (hasKeyboard()) requestAnimationFrame(() => area.current?.focus({ preventScroll: true }));
    });
  }, [draftKey]);

  const trigger = useMemo(() => {
    const found = findTrigger(text, caret);
    // A side chat takes questions: no / commands there.
    if (side && found?.kind === 'command') return undefined;
    return found && `${found.kind}:${found.start}` !== dismissed ? found : undefined;
  }, [text, caret, dismissed, side]);
  const own = useMemo(() => (onSideChat ? [BTW] : []), [onSideChat]);
  const { items: suggestions, loading: suggesting } = useSuggestions(trigger, cwd, own);
  const showSuggestions = Boolean(trigger) && (suggestions.length > 0 || suggesting);

  useEffect(() => setHighlight(0), [trigger?.kind, trigger?.query]);

  useEffect(() => {
    if (!draft || taken.has(draft)) return;
    taken.add(draft);
    // A message given back (its send failed) brings its quotes back above the box, before any added since.
    const given = draft.append || draft.block ? { quotes: [], text: draft.text } : splitQuotes(draft.text);
    if (given.quotes.length > 0) setQuotes((list) => [...given.quotes, ...list.filter((q) => !given.quotes.includes(q))]);
    const files = draft.attachments ?? [];
    const back = draft.back ? givenBack({ text, files: uploads.some((u) => !u.error) }, { text: given.text, files: files.length > 0 }, !side) : undefined;
    const next = draft.block ? withQuote(text, draft.text)
      : draft.append ? `${text}${text && !/\s$/.test(text) ? ' ' : ''}${draft.text}`
        : back ? back.text
          : given.text;
    setText(next);
    // Its files come back too: waiting with its words, or beside any added since.
    if (back?.held) {
      const waiting: Held = { text: given.text, ...(files.length > 0 ? { attachments: files } : {}) };
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

  // While Claude works: Steer (Claude reads it at its next step) or Queue (after this turn). Remembered per message.
  const [mode, setMode] = useState<SendMode>(() => getPrefs().sendWhileBusy);
  const [modeHint, setModeHint] = useState(false);
  useEffect(() => {
    if (!busy) setMode(getPrefs().sendWhileBusy);
  }, [busy]);
  useEffect(() => {
    if (!modeHint) return undefined;
    const timer = setTimeout(() => setModeHint(false), 4000);
    return () => clearTimeout(timer);
  }, [modeHint, mode]);
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
  useEffect(() => {
    if (autoFocus) takeKeys(area.current, () => area.current?.focus());
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
    saveDraft: () => draftSaver.now(text, uploads.flatMap((u) => (u.attachment ? [u.attachment] : [])), quotes, held),
    focus: () => area.current?.focus({ preventScroll: true }),
  }));

  const forget = (u: Upload) => {
    if (u.preview?.startsWith('blob:')) URL.revokeObjectURL(u.preview);
  };

  /**
   * A quote taken away. With the keys (or on a computer) they go on to the next quote, else to the
   * box; a tap on a phone leaves them, so its keyboard stays down.
   */
  const removeQuote = (at: number, byKeys: boolean) => {
    setQuotes((list) => list.filter((_, i) => i !== at));
    if (!byKeys && !hasKeyboard()) return;
    requestAnimationFrame(() => (chips.current?.querySelectorAll('button')[at] ?? area.current)?.focus({ preventScroll: true }));
  };

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

  const submit = () => {
    if (!canSend) return;
    if (shell) {
      const command = text.slice(1).trim();
      if (!command) return;
      // The quotes stay for the next message: a command is not about them.
      draftSaver.now(`!${command}`, [], quotes, held);
      onShell!(command);
      justSent.current = true;
      setText('');
      setCaret(0);
      return;
    }
    recognition.current?.stop();
    // /btw asks in the side chat, with the quotes; what goes with this session stays here.
    if (onSideChat && ASKS_BTW.test(text.trim())) {
      onSideChat(messageWithQuotes(quotes, text.trim().replace(ASKS_BTW, '')));
      setText('');
      setCaret(0);
      setQuotes([]);
      return;
    }
    // Typed out of habit in a side chat, /btw only says what the rest is.
    const words = side ? text.trim().replace(ASKS_BTW, '').trim() : text.trim();
    if (!words && quotes.length === 0 && !uploads.some((u) => u.attachment)) return;
    // A / command has to start its message, and takes nothing but its words: the quotes and files
    // wait for the next message, as with a ! command (files would go to it as its arguments).
    const command = words.startsWith('/');
    const attachments = command ? [] : uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
    draftSaver.now(words, attachments, quotes, held);
    onSend(command ? words : messageWithQuotes(quotes, words), attachments, mode);
    justSent.current = true;
    setText('');
    setCaret(0);
    if (command) return;
    setQuotes([]);
    for (const u of uploads) forget(u);
    setUploads([]);
  };

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + suggestion.insert + text.slice(trigger.end);
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
    // ⌘/Ctrl+Enter sends whatever the Enter key setting, list open or not.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
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

  const set = (patch: Partial<RunSettings>) => onSettings({ ...settings, ...patch });
  const failed = uploads.filter((u) => u.error);
  const problems = [...new Set(failed.filter((u) => !u.note).map((u) => u.error!))];
  const notes = [...new Set(failed.filter((u) => u.note).map((u) => u.error!))];
  const listOpen = showSuggestions && suggestions.length > 0;

  return (
    // In a very short window the chat scrolls as a whole; the composer stays at the bottom of it.
    <div className={`${atBottom ? 'pb-safe' : 'pb-2'} relative shrink-0 px-3 pt-1 [@media(max-height:380px)]:sticky [@media(max-height:380px)]:bottom-0 [@media(max-height:380px)]:z-10 [@media(max-height:380px)]:bg-bg`}>
      {showSuggestions && (
        <div
          id={listId}
          role="listbox"
          aria-label={trigger?.kind === 'command' ? 'Commands' : 'Files and agents'}
          className="animate-fade absolute right-3 bottom-full left-3 z-20 mx-auto mb-1 max-w-3xl overflow-hidden rounded-2xl border border-line bg-panel shadow-xl"
        >
          {suggesting && suggestions.length === 0 && <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-faint" /></div>}
          {suggestions.map((s, i) => {
            const Icon = s.icon === 'command' ? Slash : s.icon === 'folder' ? Folder : s.icon === 'agent' ? Bot : FileText;
            return (
              <button
                key={s.key}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(s)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${i === highlight ? 'bg-hover' : ''}`}
              >
                <Icon className="size-3.5 shrink-0 text-faint" />
                <span className="shrink-0 font-mono text-[13px]">{s.label}</span>
                {s.detail && <span className="min-w-0 truncate text-[12px] text-faint">{s.detail}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="mx-auto max-w-3xl rounded-[22px] border border-line bg-panel shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        {quotes.length > 0 && (
          // Scrolls sideways when the quotes do not fit, fading at the edge as the model row does.
          <ul ref={chips} aria-label="Quotes" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pt-3 [mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]">
            {quotes.map((quote, i) => {
              const label = quoteLabel(quote);
              return (
                <li key={`${i}:${quote}`} title={quote} className="flex h-8 max-w-[15rem] shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg pr-0.5 pl-2.5 text-[12.5px] text-muted">
                  <Quote aria-hidden className="size-3 shrink-0 text-faint" />
                  {/* A file's lines go by where they are; other quotes by how they begin. */}
                  <span className={`min-w-0 truncate ${quote.startsWith('>') ? '' : 'font-mono text-[12px]'}`}>{label}</span>
                  <button
                    type="button"
                    aria-label={`Remove the quote ${label}`}
                    onClick={(e) => removeQuote(i, e.detail === 0)}
                    className="relative grid size-7 shrink-0 place-items-center rounded-full text-faint after:absolute after:-inset-1.5 hover:bg-hover hover:text-fg"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
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
        {busy && modeHint && !dictationError && <div role="status" className="px-4 pt-2.5 text-[12.5px] leading-snug text-muted">{MODE_HINT[mode]}</div>}
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
                type="button"
                aria-label="Attach files"
                className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg`}
                onClick={() => picker.current?.click()}
              >
                <Paperclip className="size-[18px]" />
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
          {busy && canSend && !shell && (
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === 'steer' ? 'queue' : 'steer'));
                setModeHint(true);
              }}
              title={mode === 'steer' ? 'Claude reads it at its next step. Tap to send it after this turn instead.' : 'Sent when this turn ends. Tap to send it at Claude’s next step instead.'}
              className="relative h-8 shrink-0 rounded-full px-2 text-[12.5px] text-muted after:absolute after:-inset-y-1.5 after:inset-x-0 hover:bg-hover hover:text-fg"
            >
              {mode === 'steer' ? 'Steer' : 'Queue'}
            </button>
          )}
          {trailing}
          {listening || (!busy && !canSend && !uploading && SpeechRecognition && !disabled) ? (
            <button
              type="button"
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              onClick={dictate}
              className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full transition-colors ${listening ? 'bg-danger text-white' : 'text-muted hover:bg-hover hover:text-fg'}`}
            >
              {listening ? <span className="relative flex size-3"><span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" /><Square className="relative size-3 fill-current" /></span> : <Mic className="size-[18px]" />}
            </button>
          ) : busy && !canSend ? (
            <button type="button" aria-label={stopping ? 'Stopping' : 'Stop'} title="Stop (Esc)" aria-keyshortcuts="Escape" disabled={stopping} onClick={onStop} className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full bg-fg text-bg disabled:opacity-40`}>
              {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
              className={`${HIT} grid size-9 shrink-0 place-items-center rounded-full bg-fg text-bg transition-opacity disabled:opacity-25`}
            >
              {shell ? <SquareTerminal className="size-[17px]" /> : <ArrowUp className="size-[18px]" />}
            </button>
          )}
        </div>
      </div>

      {!side && (
        <>
          <ModelSheet open={sheet === 'model'} onClose={() => setSheet(undefined)} settings={settings} models={models} onChange={onSettings} />
          <ModeSheet open={sheet === 'mode'} onClose={() => setSheet(undefined)} offered={OFFERED_MODES} value={permission} model={model} onPick={(m) => set({ permissionMode: m })} />
        </>
      )}
    </div>
  );
}

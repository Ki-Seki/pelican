import { ArrowDown, Brain, ChevronRight, Copy, FileDiff, History, Layers, Loader2, Paperclip, Pencil, RotateCcw, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ImageBlock, LiveShell, PartialBlock, RunState, TurnChanges } from '../../shared/protocol';
import { api, apiUrl } from '../lib/api';
import { clockTime, dayLabel, duration } from '../lib/format';
import { newId } from '../lib/ids';
import { composing } from '../lib/keyboard';
import { promptBefore } from '../lib/next-steps';
import { usePathLinks } from '../lib/path-links';
import type { ViewMode } from '../lib/prefs';
import { SessionContext } from '../lib/session-context';
import { markStopping, useLiveShells } from '../lib/shells';
import { loadOlder, type SessionView } from '../lib/store';
import { describeTool } from '../lib/tools';
import { buildItems, cleanOutput, filesChangedUnder, type Item, type Part, type SentFile, withFiles } from '../lib/turns';
import { openImage } from './Lightbox';
import { CopyButton, loadsInPlace, Markdown, RemoteImage } from './Markdown';
import { PromptBody, QuoteAction } from './Quotes';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ToolCallView, ToolTarget } from './ToolCall';

const imageSrc = (image: ImageBlock) => (image.source.type === 'base64' ? `data:${image.source.media_type};base64,${image.source.data}` : image.source.url);

const matches = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;

function Thinking({ text, live, defaultOpen = false }: { text: string; live?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!text.trim()) {
    return (
      <div className="flex min-h-8 items-center gap-2 text-[13px] text-muted">
        <Brain className="size-3.5" />
        <span className={live ? 'shimmer-text' : ''}>{live ? 'Thinking…' : 'Thought'}</span>
      </div>
    );
  }
  return (
    <div>
      <button type="button" aria-expanded={open} className="flex min-h-8 items-center gap-2 text-[13px] text-muted hover:text-fg" onClick={() => setOpen((v) => !v)}>
        <Brain className="size-3.5" />
        <span className={live ? 'shimmer-text' : ''}>{live ? 'Thinking…' : 'Thought'}</span>
        <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="mt-1 mb-2 ml-5.5 border-l-2 border-line pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

type Segment = { kind: 'steps'; key: string; parts: Part[] } | Extract<Part, { kind: 'text' | 'image' }>;

/** Runs of tool calls and thinking become one block of steps between Claude's prose. */
function segment(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    if (part.kind === 'tool' || part.kind === 'thinking') {
      const last = out.at(-1);
      if (last?.kind === 'steps') last.parts.push(part);
      else out.push({ kind: 'steps', key: part.key, parts: [part] });
    } else {
      out.push(part);
    }
  }
  return out;
}

const FOLD_AFTER = 5;

/**
 * A run of steps. Normal folds a long one, keeping its end in view; Thinking lists every step, one
 * line each, with the thinking between them open; Verbose opens everything.
 */
function Steps({ parts, cwd, running, view }: { parts: Part[]; cwd?: string; running: boolean; view: ViewMode }) {
  const tools = parts.filter((p) => p.kind === 'tool').length;
  const [open, setOpen] = useState(false);
  const verbose = view === 'verbose';
  const fold = view === 'normal' && !open && !running && parts.length > FOLD_AFTER;
  const shown = fold ? parts.slice(-2) : parts;
  return (
    <div className="my-1.5">
      {fold && (
        <button type="button" aria-expanded={false} className="flex min-h-8 items-center gap-2 text-[13px] text-muted hover:text-fg" onClick={() => setOpen(true)}>
          <Layers className="size-3.5" />
          <span>{tools} steps</span>
          <span className="text-faint">· show all</span>
        </button>
      )}
      {shown.map((part) =>
        part.kind === 'tool' ? (
          <ToolCallView key={part.key} call={part.call} cwd={cwd} running={running} defaultOpen={verbose} />
        ) : part.kind === 'thinking' ? (
          <Thinking key={part.key} text={part.text} defaultOpen />
        ) : null,
      )}
    </div>
  );
}

function TurnFooter({ text, timestamp, stats }: { text?: string; timestamp?: number; stats?: RunState['lastTurn'] }) {
  return (
    <div className="-ml-1.5 flex h-7 items-center gap-1 text-[11px] text-faint opacity-0 transition-opacity select-none group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 [@media(hover:none)]:opacity-100">
      {text && <CopyButton text={text} />}
      {timestamp && <span>{clockTime(timestamp)}</span>}
      {stats && (
        <span className="tabular-nums">
          · {duration(stats.durationMs)}
          {stats.outputTokens ? ` · ${stats.outputTokens >= 1000 ? `${(stats.outputTokens / 1000).toFixed(1)}k` : stats.outputTokens} tokens out` : ''}
          {stats.costUsd ? ` · $${stats.costUsd.toFixed(2)}` : ''}
        </span>
      )}
    </div>
  );
}

/** Under a turn that changed files: how many, with the lines, opening that turn's changes. */
function TurnFiles({ turn }: { turn: TurnChanges }) {
  const openTurn = usePathLinks()?.openTurn;
  if (!openTurn) return null;
  const added = turn.files.reduce((sum, f) => sum + f.added, 0);
  const removed = turn.files.reduce((sum, f) => sum + f.removed, 0);
  return (
    <button type="button" onClick={() => openTurn(turn.uuid)} className="-mt-2 flex min-h-8 items-center gap-1.5 rounded-md text-[12.5px] text-muted hover:text-fg">
      <FileDiff className="size-3.5 shrink-0" />
      <span>{turn.files.length === 1 ? '1 file changed' : `${turn.files.length} files changed`}</span>
      {added > 0 && <span className="font-mono text-[11.5px] text-add">+{added}</span>}
      {removed > 0 && <span className="font-mono text-[11.5px] text-del">−{removed}</span>}
      <ChevronRight className="size-3.5 shrink-0 text-faint" />
    </button>
  );
}

// Headings only a screen reader sees, one per turn, so moving by headings steps through the
// conversation. Their levels sit under any heading Claude writes in a reply.
const PromptHeading = () => <h5 className="sr-only">You said:</h5>;
const TurnHeading = () => <h6 className="sr-only">Claude said:</h6>;

const AssistantTurn = memo(function AssistantTurn({
  item, cwd, running, view, stats,
}: { item: Extract<Item, { kind: 'assistant' }>; cwd?: string; running: boolean; view: ViewMode; stats?: RunState['lastTurn'] }) {
  // Claude's thinking shows from the Thinking view on, as in Desktop.
  const segments = useMemo(() => segment(view === 'normal' ? item.parts.filter((p) => p.kind !== 'thinking') : item.parts), [item.parts, view]);
  const texts = item.parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text');
  const lastText = texts.at(-1);

  return (
    <div className="group/turn" data-quotable>
      <TurnHeading />
      {segments.map((seg) =>
        seg.kind === 'steps' ? (
          <Steps key={seg.key} parts={seg.parts} cwd={cwd} running={running} view={view} />
        ) : seg.kind === 'text' ? (
          <Markdown key={seg.key} text={seg.text} className="my-2" />
        ) : seg.image.omitted ? null : !loadsInPlace(imageSrc(seg.image)) ? (
          <div key={seg.key} className="my-2"><RemoteImage src={imageSrc(seg.image)} /></div>
        ) : (
          <button key={seg.key} type="button" aria-label="Open image" className="my-2 block" onClick={() => openImage(imageSrc(seg.image))}>
            <img alt="" loading="lazy" decoding="async" className="max-h-80 rounded-lg border border-line" src={imageSrc(seg.image)} />
          </button>
        ),
      )}
      {!running && lastText && <TurnFooter text={lastText.text} timestamp={item.timestamp} stats={stats} />}
    </div>
  );
});


/** A file that went with a prompt; once the prompt is written down, a tap opens it. */
function FileChip({ file }: { file: SentFile }) {
  const style = 'flex h-9 max-w-full items-center gap-1.5 rounded-xl border border-line bg-panel px-3 font-mono text-[12.5px]';
  const body = <><Paperclip className="size-3.5 shrink-0 text-faint" /><span className="min-w-0 truncate">{file.name}</span></>;
  if (!file.id) return <span className={style}>{body}</span>;
  return <a href={apiUrl(`uploads/${file.id}`)} target="_blank" rel="noreferrer" className={`${style} hover:bg-hover`}>{body}</a>;
}

/**
 * A prompt's words, selectable like any text. Past about twelve lines (a pasted log, a file) it
 * folds, with a way to read it all. On a touch screen a tap shows the prompt's actions.
 */
function PromptText({ text, command, onTap }: { text: string; command: boolean; onTap: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  // Whether it can be long at all; the screen's width decides whether it is.
  const foldable = text.length > 300 || text.split('\n').length > 12;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !foldable || all) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [foldable, all, text]);
  return (
    <div
      onClick={() => {
        // A tap, not the end of selecting some of it.
        if (matches('(hover: none)') && !getSelection()?.toString()) onTap();
      }}
      className={`max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 break-words ${command ? 'font-mono text-[13px]' : 'text-[15px] leading-relaxed'}`}
    >
      <div
        ref={body}
        className={`whitespace-pre-wrap ${foldable && !all ? 'max-h-[19.5em] overflow-hidden' : ''} ${long && !all ? '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}`}
      >
        {command ? text : <PromptBody text={text} />}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={all}
          className="relative mt-1 text-[13px] text-muted after:absolute after:-inset-2.5 hover:text-fg"
          onClick={(e) => {
            e.stopPropagation();
            setAll((v) => !v);
          }}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

// The prompt's actions: with a pointer, quiet icons that show on hover or focus and keep their
// row; on a touch screen, labelled pills a finger can hit, laid out only once the prompt is tapped,
// so a prompt sits as close to its answer as any other item.
const ACTION = 'flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover hover:text-fg [@media(hover:none)]:relative [@media(hover:none)]:h-9 [@media(hover:none)]:rounded-full [@media(hover:none)]:px-3 [@media(hover:none)]:text-[12.5px] [@media(hover:none)]:text-muted [@media(hover:none)]:after:absolute [@media(hover:none)]:after:-inset-y-1 [@media(hover:none)]:active:bg-hover';
const LABEL = '[@media(hover:hover)]:sr-only';
const ROW_HIDDEN = 'pointer-events-none opacity-0 group-hover/user:pointer-events-auto group-hover/user:opacity-100 group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100 [@media(hover:none)]:sr-only [@media(hover:none)]:focus-within:not-sr-only';

const UserBubble = memo(function UserBubble({
  item, last, onEdit, onRewind,
}: {
  item: Extract<Item, { kind: 'user' }>;
  /** The newest prompt: an edit replaces it here instead of branching. */
  last: boolean;
  onEdit?: (uuid: string, text: string, key: string, keepImages: number[]) => Promise<boolean>;
  onRewind?: (uuid: string) => void;
}) {
  const [actions, setActions] = useState(false);
  // The id of an edit in progress, made once when the editor opens: sending twice (a retry after
  // a lost answer) gets the same branch, not a second one.
  const [editing, setEditing] = useState<string>();
  const text = item.command ? `${item.command.name} ${item.command.args}`.trim() : item.text;
  if (editing && onEdit) {
    return (
      <EditPrompt
        text={item.text}
        images={item.images}
        files={item.files}
        last={last}
        onCancel={() => setEditing(undefined)}
        onSend={(next, keep) => onEdit(item.key, withFiles(next, item.files), editing, keep).then((sent) => {
          if (sent) setEditing(undefined);
        })}
      />
    );
  }
  // A message still on its way has no actions, and hidden actions take no taps: a tap meant for
  // the composer or the list must never land on one (Edit makes a branch).
  const shown = actions && !item.pending;
  return (
    <div className={`group/user flex flex-col items-end gap-1.5 pt-2 ${item.pending ? 'opacity-60' : ''}`}>
      <PromptHeading />
      {(item.images.length > 0 || item.files.length > 0) && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.images.map((image, i) =>
            image.omitted ? null : !loadsInPlace(imageSrc(image)) ? (
              <RemoteImage key={i} src={imageSrc(image)} />
            ) : (
              <button key={i} type="button" aria-label="Open image" onClick={() => openImage(imageSrc(image))}>
                <img alt="" loading="lazy" decoding="async" className="max-h-44 rounded-xl border border-line object-cover" src={imageSrc(image)} />
              </button>
            ),
          )}
          {item.files.map((file, i) => <FileChip key={`file-${i}`} file={file} />)}
        </div>
      )}
      {text && <PromptText text={text} command={Boolean(item.command)} onTap={() => !item.pending && setActions((v) => !v)} />}
      {item.pending ? (
        <div className="text-[11px] text-faint">{item.queued ? 'Queued · sent when this turn ends' : 'Sending…'}</div>
      ) : text && (
        <div className={`flex items-center gap-0.5 text-[11px] text-faint transition-opacity [@media(hover:none)]:gap-1 ${shown ? '' : ROW_HIDDEN}`}>
          {item.timestamp && <span className="mr-1">{clockTime(item.timestamp)}{item.steered ? ' · while Claude worked' : ''}</span>}
          <button type="button" title="Copy" className={ACTION} onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy className="size-3.5" /><span className={LABEL}>Copy</span>
          </button>
          {onEdit && !item.command && (
            <button
              type="button"
              title={last ? 'Edit and send again, in place of this prompt' : 'Edit and send again, as a new branch'}
              className={ACTION}
              onClick={() => {
                setActions(false);
                setEditing(newId());
              }}
            >
              <Pencil className="size-3.5" /><span className={LABEL}>Edit</span>
            </button>
          )}
          {onRewind && !item.command && (
            <button type="button" title="Rewind code: put files back the way they were before this prompt" className={ACTION} onClick={() => onRewind(item.key)}>
              <History className="size-3.5" /><span className={LABEL}>Rewind</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Editing a prompt in place. Nothing changes until Send: then the conversation branches just
 * before this prompt and the new text, with the images kept, goes there; this session stays as
 * it was. While it sends there is nothing to cancel: the branch is being made.
 */
function EditPrompt({ text, images, files, last, onCancel, onSend }: {
  text: string;
  images: ImageBlock[];
  /** Files sent with the prompt; they go along with the edit. */
  files: SentFile[];
  last: boolean;
  onCancel: () => void;
  onSend: (text: string, keepImages: number[]) => Promise<void>;
}) {
  const [value, setValue] = useState(text);
  // Positions among all the prompt's images, as the server counts them; only those held in the
  // transcript (not a link to one elsewhere) can go along.
  const carried = images.flatMap((image, i) => (image.source.type === 'base64' || image.source.url.startsWith('api/sessions/') ? [i] : []));
  const [kept, setKept] = useState(carried);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);
  useEffect(() => {
    const el = field.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const send = () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    void onSend(value.trim(), kept).finally(() => setBusy(false));
  };
  return (
    <div className="ml-auto w-full max-w-[85%] rounded-2xl border border-line bg-panel p-2">
      {carried.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-1 pt-1">
          {carried.map((i) => {
            const image = images[i]!;
            const keep = kept.includes(i);
            return (
              <button
                key={i}
                type="button"
                disabled={busy}
                aria-label={keep ? 'Leave this image out' : 'Keep this image'}
                title={keep ? 'Leave this image out' : 'Keep this image'}
                onClick={() => setKept((all) => (keep ? all.filter((k) => k !== i) : [...all, i].sort((a, b) => a - b)))}
                className="relative"
              >
                {image.omitted ? (
                  <span className={`grid size-14 place-items-center rounded-lg border border-line text-[11px] text-faint ${keep ? '' : 'opacity-30'}`}>Image</span>
                ) : (
                  <img alt="" src={imageSrc(image)} className={`size-14 rounded-lg border border-line object-cover ${keep ? '' : 'opacity-30'}`} />
                )}
                <span className="absolute -top-1 -right-1 grid size-4.5 place-items-center rounded-full bg-fg text-bg"><X className="size-3" /></span>
              </button>
            );
          })}
        </div>
      )}
      {files.some((file) => file.path) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-1 pt-1">
          {files.filter((file) => file.path).map((file, i) => <FileChip key={i} file={{ name: file.name }} />)}
        </div>
      )}
      {/* 16px: a smaller field makes Safari on iOS zoom the page when it gets focus. */}
      <textarea
        ref={field}
        value={value}
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Keys an input method takes are its own: Esc there cancels a conversion, not the edit.
          if (composing(e.nativeEvent)) return;
          if (e.key === 'Escape' && !busy) onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
        aria-label="Edit the prompt"
        className="block w-full resize-none bg-transparent px-1.5 py-1 text-[16px] leading-relaxed outline-none"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <span className="mr-auto px-1.5 text-[11.5px] leading-snug text-faint">
          {busy ? 'Sending…' : last ? 'Replaces this prompt and Claude’s answer to it.' : 'Sends as a new branch; this one stays as it is.'}
        </span>
        <button type="button" onClick={onCancel} disabled={busy} className="h-8 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40">Cancel</button>
        <button type="button" onClick={send} disabled={busy || !value.trim()} className="flex h-8 items-center rounded-full bg-fg px-3.5 text-[13px] font-medium text-bg disabled:opacity-40">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** `onNext`: the next step an error line offers, where it ends the conversation (Retry, or Compact). */
function Notice({ item, onNext }: { item: Extract<Item, { kind: 'notice' }>; onNext?: () => void }) {
  const [open, setOpen] = useState(false);
  if (item.tone === 'interrupt') {
    return <div className="flex items-center gap-2 text-[12px] text-faint"><span className="h-px flex-1 bg-line" />Interrupted<span className="h-px flex-1 bg-line" /></div>;
  }
  if (item.tone === 'output') {
    return <pre className="max-h-60 overflow-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted">{item.text}</pre>;
  }
  if (item.tone === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-danger">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
        {onNext && (
          <button type="button" onClick={onNext} className="relative -my-1 -mr-1.5 h-7 shrink-0 rounded-full bg-chip px-3 text-[12.5px] text-fg after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover">
            {item.next === 'compact' ? 'Compact' : 'Retry'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="text-[13px] text-muted">
      <button type="button" {...(item.detail ? { 'aria-expanded': open } : {})} className="flex min-h-7 items-center gap-2 text-left hover:text-fg" onClick={() => setOpen((v) => !v)}>
        <SquareTerminal className="size-3.5 shrink-0" />
        <span>{item.text}</span>
        {item.detail && <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />}
      </button>
      {open && item.detail && <div className="mt-1 ml-5.5"><Markdown text={item.detail} className="text-[13.5px]" /></div>}
    </div>
  );
}

/** The summary without what Claude Code wraps around it for the model: the preamble and tagged notes. */
function readableSummary(summary: string): string {
  return summary
    .replace(/<(tools-used-before-summary|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/^This session is being continued from a previous conversation[^\n]*\n+/, '')
    .replace(/\n*If you need specific details from before compaction[\s\S]*$/, '')
    .trim();
}

/** How many of a long output's last lines a finished command shows, as much as its live card did. */
const TAIL_LINES = 12;

/** A command as a control names it: its first line, cut short. */
const commandName = (command: string) => {
  const first = command.trim().split('\n')[0] ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
};

/**
 * A `!` command someone ran in the session, with its output. A long output shows its end, the
 * result, as the command's live card did while it ran; Show all shows it from the start.
 */
function ShellItem({ item }: { item: Extract<Item, { kind: 'shell' }> }) {
  const [all, setAll] = useState(false);
  const output = useMemo(() => [item.stdout, item.stderr].map(cleanOutput).filter((part) => part.trim()).join('\n').replace(/^\s*\n/, '').trimEnd(), [item.stdout, item.stderr]);
  const lines = output.split('\n');
  const long = lines.length > 14 || output.length > 1600;
  const clipped = long && !all;
  return (
    <div data-quotable className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-[12.5px]">
        <SquareTerminal className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 break-words">{item.command}</span>
        {item.timestamp && <span className="shrink-0 font-sans text-[11px] text-faint">{clockTime(item.timestamp)}</span>}
      </div>
      {output && (
        // Clipped, its last lines sit at the bottom of the box, the start fading out above them.
        <pre className={`border-t border-line px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted ${clipped ? 'flex max-h-60 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_top,black_75%,transparent)]' : ''}`}>
          <span>{clipped ? lines.slice(-TAIL_LINES).join('\n') : output}</span>
        </pre>
      )}
      {long && (
        <button type="button" aria-expanded={all} className="w-full border-t border-line py-1.5 text-[12px] text-faint hover:text-fg" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/**
 * A `!` command still running: its output as it comes, the end in view, and Stop, which ends it
 * and everything it started. Once done it waits, if Claude is in a turn, to go into the conversation.
 */
function LiveShellItem({ sessionId, shell }: { sessionId: string; shell: LiveShell }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (shell.done) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shell.done]);
  const output = useMemo(() => cleanOutput(shell.output).replace(/^\s*\n/, '').trimEnd(), [shell.output]);
  // The end stays in view as output comes, unless the reader scrolled up in it to read.
  const body = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (body.current && following.current) body.current.scrollTop = body.current.scrollHeight;
  }, [output]);
  const stop = () => {
    markStopping(sessionId, shell.id);
    void api.stopShell(sessionId, shell.id).catch(() => undefined);
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3 font-mono text-[12.5px]">
        <SquareTerminal className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 break-words">{shell.command}</span>
        {shell.done ? (
          <span className="shrink-0 pr-1.5 font-sans text-[11px] text-faint">{shell.done.code === null ? 'Stopped' : shell.done.code === 0 ? 'Done' : `Exit code ${shell.done.code}`}</span>
        ) : (
          <>
            <Loader2 className="size-3.5 shrink-0 animate-spin text-faint motion-reduce:animate-none" />
            <span className="shrink-0 font-sans text-[11px] text-faint tabular-nums">{duration(Math.max(0, now - shell.startedAt))}</span>
            {/* Named for its command: the turn's own Stop, by the message box, is another. */}
            <button type="button" disabled={shell.stopping} onClick={stop} aria-label={`${shell.stopping ? 'Stopping' : 'Stop'} ${commandName(shell.command)}`} className="relative h-7 shrink-0 rounded-full px-2.5 font-sans text-[12px] text-muted after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg disabled:opacity-50">
              {shell.stopping ? 'Stopping' : 'Stop'}
            </button>
          </>
        )}
      </div>
      {output && (
        <pre
          ref={body}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
          className="max-h-60 overflow-y-auto overscroll-contain border-t border-line px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted"
        >
          {output}
        </pre>
      )}
      {(shell.error || shell.done?.waiting || shell.truncated) && (
        <div className={`border-t border-line px-3 py-1.5 text-[12px] ${shell.error ? 'text-danger' : 'text-faint'}`}>
          {shell.error ?? (shell.done?.waiting ? 'Goes into the conversation when Claude’s turn ends' : 'Output past 200 KB is left out; the command runs on')}
        </div>
      )}
    </div>
  );
}

/** Where Claude Code condensed the conversation: everything above, Claude now knows from this summary. */
function Compacted({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-1">
      <button type="button" className="flex w-full items-center gap-2 text-[12px] text-faint hover:text-fg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="h-px flex-1 bg-line" />
        <RotateCcw className="size-3" />
        Context compacted
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="h-px flex-1 bg-line" />
      </button>
      {open && (
        <div className="animate-fade mt-2 rounded-xl border border-line bg-panel px-3 py-2">
          <div className="mb-1 text-[12px] text-faint">Claude carries on from this summary of everything above.</div>
          <Markdown text={readableSummary(summary)} className="text-[13.5px]" />
        </div>
      )}
    </div>
  );
}

function partialTarget(block: Extract<PartialBlock, { type: 'tool_use' }>): Record<string, unknown> {
  try {
    return JSON.parse(block.inputJson) as Record<string, unknown>;
  } catch {
    // Partial JSON: pull out the first string field so the row says what it is doing.
    const match = block.inputJson.match(/"(description|command|file_path|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    return match ? { [match[1]!]: match[2]!.replace(/\\n/g, ' ') } : {};
  }
}

function LiveOutput({ run, cwd, since, view }: { run: RunState; cwd?: string; since?: number; view: ViewMode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const hasText = run.partial.some((b) => b.type === 'text' && b.text);
  // How long Claude has waited for you, or worked on this turn, as the terminal counts it; not
  // since this page opened. With neither known, no number.
  const start = run.permissions[0]?.createdAt ?? run.startedAt ?? since;
  return (
    <div>
      {run.partial.map((block, i) => {
        if (block.type === 'text') return block.text ? <StreamingMarkdown key={i} text={block.text} className="my-2" /> : null;
        // Normal says that Claude thinks; the other views show what, as it comes.
        if (block.type === 'thinking') return <Thinking key={i} text={view === 'normal' ? '' : block.thinking} live defaultOpen />;
        const summary = describeTool(block.name, partialTarget(block), cwd);
        const Icon = summary.icon;
        return (
          <div key={i} className="flex min-h-8 items-center gap-2 text-[13px] text-muted">
            <Icon className="size-3.5" />
            <span className="text-fg/80">{summary.verb}</span>
            {summary.target && <ToolTarget summary={summary} />}
            <Loader2 className="ml-auto size-3.5 animate-spin text-faint" />
          </div>
        );
      })}
      {!hasText && (
        <div className="flex min-h-8 items-center gap-2 text-[13px]">
          <span className="relative flex size-2">
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none ${run.permissions.length > 0 ? 'bg-wait' : 'bg-run'}`} />
            <span className={`relative inline-flex size-2 rounded-full ${run.permissions.length > 0 ? 'bg-wait' : 'bg-run'}`} />
          </span>
          <span className="shimmer-text">
            {run.permissions.length > 0 ? 'Waiting for you'
              : run.activity?.kind === 'compacting' ? 'Compacting the conversation'
                : run.activity?.kind === 'retrying' ? `The API is busy; trying again (${run.activity.attempt} of ${run.activity.max})`
                  : 'Working'}
          </span>
          {start !== undefined && <span className="text-faint tabular-nums">{duration(Math.max(0, now - start))}</span>}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  sessionId, view, cwd, machine, mode, onEdit, onRewind, onRetry, onCompact, quoteKey,
}: {
  sessionId: string;
  view: SessionView;
  /** Whose message box a quote of a reply goes to (lib/quote); the conversation's own by default. */
  quoteKey?: string;
  cwd?: string;
  /** The computer Claude Code runs on, for error lines that say what to do there. */
  machine?: string;
  mode: ViewMode;
  onEdit?: (uuid: string, text: string, key: string, keepImages: number[]) => Promise<boolean>;
  onRewind?: (uuid: string) => void;
  /** The next step on an API error that ends the conversation: send its prompt again, or /compact. */
  onRetry?: (prompt: Extract<Item, { kind: 'user' }>) => void;
  onCompact?: () => void;
}) {
  const items = useMemo(() => buildItems(view.messages, machine), [view.messages, machine]);
  // A `!` command shows live until its record replaces it, under the same id.
  const shells = useLiveShells(sessionId);
  const live = useMemo(() => new Set(shells.map((shell) => shell.id)), [shells]);
  // The prompt this browser sent last, while it is on its way: sending always brings the end into view.
  const sending = useMemo(() => [...items].reverse().find((i) => i.kind === 'user' && i.pending)?.key, [items]);
  const lastSending = useRef<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Following the newest output. Stops the moment the reader scrolls up or opens something; any other tap leaves it be. */
  const atBottom = useRef(true);
  /** A finger is on the list: never move it under them. */
  const touching = useRef(false);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const busy = Boolean(view.run?.busy);
  const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')?.key;
  const lastPrompt = [...items].reverse().find((i) => i.kind === 'user' && !i.command)?.key;
  // A failed turn's error, said once: the conversation may already end on Claude Code's note of it.
  const lastItem = items.at(-1);
  const endsOnError = lastItem?.kind === 'notice' && lastItem.tone === 'error';

  // When the running turn began, for a run that does not say: the prompt that started it.
  const promptAt = items.findLast((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && !i.steered)?.timestamp;

  // The files each turn changed, said under the last of Claude's answers in it.
  const turns = usePathLinks()?.turns;
  const changedUnder = useMemo(() => filesChangedUnder(items, turns ?? []), [items, turns]);

  /**
   * After anything that changes the list's size or position: back to the end while following,
   * and the jump button whenever there is more below. The position is noted before the browser
   * reports the scroll, so a page that grew or shrank is not taken for the reader scrolling up.
   */
  const settle = () => {
    const el = scroller.current;
    if (!el) return;
    // Text being selected stays where it is, still following; the jump button says there is more.
    const selection = typeof getSelection === 'function' ? getSelection() : null;
    const selecting = Boolean(selection && !selection.isCollapsed && selection.anchorNode && el.contains(selection.anchorNode));
    if (atBottom.current && !touching.current && !selecting) el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  };

  // Older messages are about to go in above: note where the reader is before the page changes,
  // so the same lines stay on screen. (The browser's own scroll anchoring is off for this list.)
  const snapshot = useRef<{ top: number; height: number } | undefined>(undefined);
  const lastOffset = useRef(view.offset);
  if (view.offset < lastOffset.current && scroller.current && !snapshot.current) {
    snapshot.current = { top: scroller.current.scrollTop, height: scroller.current.scrollHeight };
  }
  lastOffset.current = view.offset;

  // Keep the newest content in view while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (sending && sending !== lastSending.current) {
      // The finger was on the composer, not the list; a touch whose end never arrived (its element
      // was replaced mid-touch) must not keep the new prompt out of view.
      atBottom.current = true;
      touching.current = false;
    }
    lastSending.current = sending;
    if (snapshot.current) {
      el.scrollTop = snapshot.current.top + (el.scrollHeight - snapshot.current.height);
      snapshot.current = undefined;
    }
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, view.run?.partial, mode]);

  // What grows or shrinks after it is drawn keeps the end in view too: pictures and frames that
  // get their height once loaded, an approval card or a notice that takes room from the list.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => settle());
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    atBottom.current = true;
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Near the top, or with too little to scroll at all, the next older page loads by itself:
  // a page of folded steps can be short, and a list that cannot scroll never sees a scroll.
  const loadIfNearTop = () => {
    const el = scroller.current;
    if (!el || view.offset === 0 || view.loadingOlder || !view.loaded) return;
    if (el.scrollTop < 400 || el.scrollHeight <= el.clientHeight + 400) void loadOlder(sessionId);
  };
  useEffect(() => {
    const timer = setTimeout(loadIfNearTop, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.offset, view.loadingOlder, view.loaded, mode]);

  // Any move up is the reader's: stop following at once, not only once they are far from the end
  // (streamed text arrives every few frames and would pull them back down before they got there).
  // Following resumes when they come back to the very end. A move up that leaves the list at its
  // end is not the reader's but the browser's: the list grew taller (an approval card went) and
  // the browser pulled the top down with it, before the size change below gets to settle it.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastTop.current - 2 && distance > 2) atBottom.current = false;
    else if (distance < 24) atBottom.current = true;
    lastTop.current = el.scrollTop;
    setShowJump(distance > 80);
    loadIfNearTop();
  };

  return (
    <SessionContext.Provider value={sessionId}>
    <div className="relative min-h-0 flex-1">
      {/* Opening or closing something (a step, a long output) is reading, not following: what
          arrives next must not pull it away. A tap that opens nothing (selecting text, a link,
          Copy) leaves following as it was. Scrolling back down to the end follows again. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        onClickCapture={(e) => {
          if ((e.target as Element).closest?.('[aria-expanded], [aria-pressed], summary')) atBottom.current = false;
        }}
        onTouchStart={() => { touching.current = true; }}
        onTouchEnd={() => {
          touching.current = false;
          settle();
        }}
        onTouchCancel={() => {
          touching.current = false;
          settle();
        }}
        onWheel={(e) => { if (e.deltaY < 0) atBottom.current = false; }}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div ref={content} className="relative mx-auto max-w-3xl px-4 pt-3 pb-6">
          <QuoteAction within={content} quoteKey={quoteKey ?? sessionId} />
          {view.offset > 0 && (
            <div className="flex justify-center py-3">
              {view.loadingOlder ? (
                <Loader2 className="size-4 animate-spin text-faint" />
              ) : (
                <button type="button" onClick={() => void loadOlder(sessionId)} className="h-8 rounded-full px-3 text-[12px] text-faint hover:bg-hover hover:text-fg">
                  Show earlier messages · {view.offset}
                </button>
              )}
            </div>
          )}
          {!view.loaded && (
            <div className="flex justify-center py-16 text-faint"><Loader2 className="size-5 animate-spin" /></div>
          )}
          {view.error && (
            <div className="my-6 flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-danger">
              <TriangleAlert className="size-4" /> {view.error}
            </div>
          )}
          <div className="space-y-4">
            {items.map((item, at) => {
              switch (item.kind) {
                case 'user':
                  return <UserBubble key={item.key} item={item} last={item.key === lastPrompt} {...(onEdit ? { onEdit } : {})} {...(onRewind ? { onRewind } : {})} />;
                case 'shell':
                  return live.has(item.key) ? null : <ShellItem key={item.key} item={item} />;
                case 'assistant': {
                  const running = busy && item.key === lastAssistant;
                  const changed = running ? undefined : changedUnder.get(item.key);
                  return (
                    <Fragment key={item.key}>
                      <AssistantTurn
                        item={item}
                        cwd={cwd}
                        view={mode}
                        running={running}
                        {...(item.key === lastAssistant && view.run?.lastTurn ? { stats: view.run.lastTurn } : {})}
                      />
                      {changed && <TurnFiles turn={changed} />}
                    </Fragment>
                  );
                }
                case 'notice': {
                  // Only the error the conversation ends on, with Claude idle, offers a way on.
                  const ends = endsOnError && !busy && at === items.length - 1;
                  const prompt = ends && item.next === 'retry' && onRetry ? promptBefore(items, at) : undefined;
                  const next = prompt ? () => onRetry!(prompt) : ends && item.next === 'compact' ? onCompact : undefined;
                  return <Notice key={item.key} item={item} {...(next ? { onNext: next } : {})} />;
                }
                case 'compact':
                  return <Compacted key={item.key} summary={item.summary} />;
                case 'day':
                  return <div key={item.key} className="pt-2 text-center text-[11px] font-medium tracking-wide text-faint uppercase">{dayLabel(item.timestamp)}</div>;
                default:
                  return null;
              }
            })}
            {busy && view.run && <LiveOutput run={view.run} cwd={cwd} view={mode} {...(promptAt ? { since: promptAt } : {})} />}
            {!busy && view.run?.error && !endsOnError && (
              <div className="flex items-start gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-danger">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span className="whitespace-pre-wrap">{view.run.error}</span>
              </div>
            )}
            {shells.map((shell) => <LiveShellItem key={shell.id} sessionId={sessionId} shell={shell} />)}
          </div>
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          aria-label="Jump to latest"
          className="animate-fade absolute bottom-3 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-line bg-panel shadow-md after:absolute after:-inset-1"
          onClick={() => {
            const el = scroller.current;
            if (!el) return;
            atBottom.current = true;
            el.scrollTo({ top: el.scrollHeight, behavior: matches('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
          }}
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
    </SessionContext.Provider>
  );
}

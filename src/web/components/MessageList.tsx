import { ArrowDown, Brain, ChevronRight, Copy, History, Layers, Loader2, Pencil, RotateCcw, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ImageBlock, PartialBlock, RunState } from '../../shared/protocol';
import { clockTime, dayLabel, duration } from '../lib/format';
import { newId } from '../lib/ids';
import type { ViewMode } from '../lib/prefs';
import { SessionContext } from '../lib/session-context';
import { loadOlder, type SessionView } from '../lib/store';
import { describeTool } from '../lib/tools';
import { buildItems, type Item, type Part } from '../lib/turns';
import { openImage } from './Lightbox';
import { CopyButton, loadsInPlace, Markdown, RemoteImage } from './Markdown';
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

function Steps({ parts, cwd, running, verbose }: { parts: Part[]; cwd?: string; running: boolean; verbose: boolean }) {
  const tools = parts.filter((p) => p.kind === 'tool').length;
  const [open, setOpen] = useState(false);
  const fold = !verbose && !open && !running && parts.length > FOLD_AFTER;
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
          <Thinking key={part.key} text={part.text} defaultOpen={verbose} />
        ) : null,
      )}
    </div>
  );
}

function TurnFooter({ text, timestamp, stats }: { text?: string; timestamp?: number; stats?: RunState['lastTurn'] }) {
  return (
    <div className="-ml-1.5 flex h-7 items-center gap-1 text-[11px] text-faint opacity-0 transition-opacity group-hover/turn:opacity-100 [@media(hover:none)]:opacity-100">
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

const AssistantTurn = memo(function AssistantTurn({
  item, cwd, running, view, stats,
}: { item: Extract<Item, { kind: 'assistant' }>; cwd?: string; running: boolean; view: ViewMode; stats?: RunState['lastTurn'] }) {
  const segments = useMemo(() => segment(item.parts), [item.parts]);
  const texts = item.parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text');
  const lastText = texts.at(-1);
  const steps = item.parts.filter((p) => p.kind === 'tool').length;

  if (view === 'summary') {
    // Visuals Claude drew are part of the answer, so they stay with the reply.
    const visuals = item.parts.filter((p): p is Extract<Part, { kind: 'tool' }> => p.kind === 'tool' && /(^|__)show_widget$/.test(p.call.name));
    if (!lastText && !running && visuals.length === 0) {
      return steps > 0 ? <div className="flex items-center gap-2 text-[12.5px] text-faint"><Layers className="size-3.5" />{steps} steps, no reply</div> : null;
    }
    return (
      <div className="group/turn">
        {steps > 0 && <div className="flex items-center gap-2 text-[12px] text-faint"><Layers className="size-3" />{steps} step{steps === 1 ? '' : 's'}</div>}
        {visuals.map((part) => <ToolCallView key={part.key} call={part.call} cwd={cwd} running={false} />)}
        {lastText && <Markdown text={lastText.text} className="my-2" />}
        {!running && <TurnFooter text={lastText?.text} timestamp={item.timestamp} stats={stats} />}
      </div>
    );
  }

  return (
    <div className="group/turn">
      {segments.map((seg) =>
        seg.kind === 'steps' ? (
          <Steps key={seg.key} parts={seg.parts} cwd={cwd} running={running} verbose={view === 'verbose'} />
        ) : seg.kind === 'text' ? (
          <Markdown key={seg.key} text={seg.text} className="my-2" />
        ) : seg.image.omitted ? null : !loadsInPlace(imageSrc(seg.image)) ? (
          <div key={seg.key} className="my-2"><RemoteImage src={imageSrc(seg.image)} /></div>
        ) : (
          <button key={seg.key} type="button" aria-label="Open image" className="my-2 block" onClick={() => openImage(imageSrc(seg.image))}>
            <img alt="" className="max-h-80 rounded-lg border border-line" src={imageSrc(seg.image)} />
          </button>
        ),
      )}
      {!running && lastText && <TurnFooter text={lastText.text} timestamp={item.timestamp} stats={stats} />}
    </div>
  );
});


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
        last={last}
        onCancel={() => setEditing(undefined)}
        onSend={(next, keep) => onEdit(item.key, next, editing, keep).then((sent) => {
          if (sent) setEditing(undefined);
        })}
      />
    );
  }
  // A message still on its way has no actions, and hidden actions take no taps: a tap meant for
  // the composer or the list must never land on one (Edit makes a branch).
  const shown = actions && !item.pending;
  return (
    <div className={`group/user flex flex-col items-end gap-1.5 ${item.pending ? 'opacity-60' : ''}`}>
      {item.images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.images.map((image, i) =>
            image.omitted ? null : !loadsInPlace(imageSrc(image)) ? (
              <RemoteImage key={i} src={imageSrc(image)} />
            ) : (
              <button key={i} type="button" aria-label="Open image" onClick={() => openImage(imageSrc(image))}>
                <img alt="" className="max-h-44 rounded-xl border border-line object-cover" src={imageSrc(image)} />
              </button>
            ),
          )}
        </div>
      )}
      {text && (
        <button
          type="button"
          onClick={() => !item.pending && setActions((v) => !v)}
          className={`max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 text-left whitespace-pre-wrap break-words ${item.command ? 'font-mono text-[13px]' : 'text-[15px] leading-relaxed'}`}
        >
          {text}
        </button>
      )}
      {item.pending ? (
        <div className="text-[11px] text-faint">{item.queued ? 'Queued · sent when this turn ends' : 'Sending…'}</div>
      ) : text && (
        <div
          className={`flex h-7 items-center gap-0.5 text-[11px] text-faint transition-opacity ${shown ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover/user:pointer-events-auto group-hover/user:opacity-100'}`}
        >
          {item.timestamp && <span className="mr-1">{clockTime(item.timestamp)}{item.steered ? ' · while Claude worked' : ''}</span>}
          <button type="button" aria-label="Copy" title="Copy" className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy className="size-3.5" />
          </button>
          {onEdit && !item.command && (
            <button
              type="button"
              aria-label="Edit"
              title={last ? 'Edit and send again, in place of this prompt' : 'Edit and send again, as a new branch'}
              className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg"
              onClick={() => {
                setActions(false);
                setEditing(newId());
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          {onRewind && !item.command && (
            <button type="button" aria-label="Rewind code to here" title="Rewind code: put files back the way they were before this prompt" className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg" onClick={() => onRewind(item.key)}>
              <History className="size-3.5" />
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
function EditPrompt({ text, images, last, onCancel, onSend }: {
  text: string;
  images: ImageBlock[];
  last: boolean;
  onCancel: () => void;
  onSend: (text: string, keepImages: number[]) => Promise<void>;
}) {
  const [value, setValue] = useState(text);
  // Positions among all the prompt's images, as the server counts them; only those held in the
  // transcript (not a link to one elsewhere) can go along.
  const carried = images.flatMap((image, i) => (image.source.type === 'base64' ? [i] : []));
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
      <textarea
        ref={field}
        value={value}
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
        aria-label="Edit the prompt"
        className="block w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed outline-none"
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

function Notice({ item }: { item: Extract<Item, { kind: 'notice' }> }) {
  const [open, setOpen] = useState(false);
  if (item.tone === 'interrupt') {
    return <div className="flex items-center gap-2 text-[12px] text-faint"><span className="h-px flex-1 bg-line" />Interrupted<span className="h-px flex-1 bg-line" /></div>;
  }
  if (item.tone === 'output') {
    return <pre className="max-h-60 overflow-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted">{item.text}</pre>;
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

/** Where Claude Code condensed the conversation: everything above, Claude now knows from this summary. */
/** A `!` command someone ran in the session, with its output. */
function ShellItem({ item }: { item: Extract<Item, { kind: 'shell' }> }) {
  const [all, setAll] = useState(false);
  const output = [item.stdout, item.stderr].filter((part) => part.trim()).join('\n').trimEnd();
  const long = output.split('\n').length > 14 || output.length > 1600;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-[12.5px]">
        <SquareTerminal className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 break-all">{item.command}</span>
        {item.timestamp && <span className="shrink-0 font-sans text-[11px] text-faint">{clockTime(item.timestamp)}</span>}
      </div>
      {output && (
        <pre className={`border-t border-line px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted ${long && !all ? 'max-h-60 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]' : ''}`}>{output}</pre>
      )}
      {long && (
        <button type="button" aria-expanded={all} className="w-full border-t border-line py-1.5 text-[12px] text-faint hover:text-fg" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

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

function LiveOutput({ run, cwd }: { run: RunState; cwd?: string }) {
  const [now, setNow] = useState(Date.now());
  const [since] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const hasText = run.partial.some((b) => b.type === 'text' && b.text);
  return (
    <div>
      {run.partial.map((block, i) => {
        if (block.type === 'text') return block.text ? <Markdown key={i} text={block.text} className="my-2" /> : null;
        if (block.type === 'thinking') return <Thinking key={i} text={block.thinking} live />;
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
          <span className="text-faint tabular-nums">{duration(now - since)}</span>
        </div>
      )}
    </div>
  );
}

export function MessageList({
  sessionId, view, cwd, mode, onEdit, onRewind,
}: {
  sessionId: string;
  view: SessionView;
  cwd?: string;
  mode: ViewMode;
  onEdit?: (uuid: string, text: string, key: string, keepImages: number[]) => Promise<boolean>;
  onRewind?: (uuid: string) => void;
}) {
  const items = useMemo(() => buildItems(view.messages), [view.messages]);
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
  // Following resumes when they come back to the very end.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastTop.current - 2) atBottom.current = false;
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
        <div ref={content} className="mx-auto max-w-3xl px-4 pt-3 pb-6">
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
          <div className={mode === 'summary' ? 'space-y-3' : 'space-y-4'}>
            {items.map((item) => {
              switch (item.kind) {
                case 'user':
                  return <UserBubble key={item.key} item={item} last={item.key === lastPrompt} {...(onEdit ? { onEdit } : {})} {...(onRewind ? { onRewind } : {})} />;
                case 'shell':
                  return <ShellItem key={item.key} item={item} />;
                case 'assistant':
                  return (
                    <AssistantTurn
                      key={item.key}
                      item={item}
                      cwd={cwd}
                      view={mode}
                      running={busy && item.key === lastAssistant}
                      {...(item.key === lastAssistant && view.run?.lastTurn ? { stats: view.run.lastTurn } : {})}
                    />
                  );
                case 'notice':
                  return mode === 'summary' && item.tone === 'output' ? null : <Notice key={item.key} item={item} />;
                case 'compact':
                  return <Compacted key={item.key} summary={item.summary} />;
                case 'day':
                  return <div key={item.key} className="pt-2 text-center text-[11px] font-medium tracking-wide text-faint uppercase">{dayLabel(item.timestamp)}</div>;
                default:
                  return null;
              }
            })}
            {busy && view.run && <LiveOutput run={view.run} cwd={cwd} />}
            {!busy && view.run?.error && (
              <div className="flex items-start gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-danger">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span className="whitespace-pre-wrap">{view.run.error}</span>
              </div>
            )}
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

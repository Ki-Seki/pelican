import { ArrowDown, Brain, ChevronRight, Copy, Layers, Loader2, Pencil, RotateCcw, SquareTerminal, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ImageBlock, PartialBlock, RunState } from '../../shared/protocol';
import { clockTime, dayLabel, duration } from '../lib/format';
import type { ViewMode } from '../lib/prefs';
import { loadOlder, type SessionView } from '../lib/store';
import { describeTool } from '../lib/tools';
import { buildItems, type Item, type Part } from '../lib/turns';
import { openImage } from './Lightbox';
import { CopyButton, Markdown } from './Markdown';
import { ToolCallView, ToolTarget } from './ToolCall';

const imageSrc = (image: ImageBlock) => (image.source.type === 'base64' ? `data:${image.source.media_type};base64,${image.source.data}` : image.source.url);

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
      <button type="button" className="flex min-h-8 items-center gap-2 text-[13px] text-muted hover:text-fg" onClick={() => setOpen((v) => !v)}>
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
        <button type="button" className="flex min-h-8 items-center gap-2 text-[13px] text-muted hover:text-fg" onClick={() => setOpen(true)}>
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
    if (!lastText && !running) {
      return steps > 0 ? <div className="flex items-center gap-2 text-[12.5px] text-faint"><Layers className="size-3.5" />{steps} steps, no reply</div> : null;
    }
    return (
      <div className="group/turn">
        {steps > 0 && <div className="flex items-center gap-2 text-[12px] text-faint"><Layers className="size-3" />{steps} step{steps === 1 ? '' : 's'}</div>}
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
        ) : !seg.image.omitted ? (
          <button key={seg.key} type="button" className="my-2 block" onClick={() => openImage(imageSrc(seg.image))}>
            <img alt="" className="max-h-80 rounded-lg border border-line" src={imageSrc(seg.image)} />
          </button>
        ) : null,
      )}
      {!running && lastText && <TurnFooter text={lastText.text} timestamp={item.timestamp} stats={stats} />}
    </div>
  );
});

const UserBubble = memo(function UserBubble({ item, onEdit }: { item: Extract<Item, { kind: 'user' }>; onEdit?: (uuid: string, text: string) => void }) {
  const [actions, setActions] = useState(false);
  const text = item.command ? `${item.command.name} ${item.command.args}`.trim() : item.text;
  return (
    <div className={`group/user flex flex-col items-end gap-1.5 ${item.pending ? 'opacity-60' : ''}`}>
      {item.images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.images.map((image, i) =>
            image.omitted ? null : (
              <button key={i} type="button" onClick={() => openImage(imageSrc(image))}>
                <img alt="" className="max-h-44 rounded-xl border border-line object-cover" src={imageSrc(image)} />
              </button>
            ),
          )}
        </div>
      )}
      {text && (
        <button
          type="button"
          onClick={() => setActions((v) => !v)}
          className={`max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 text-left whitespace-pre-wrap break-words ${item.command ? 'font-mono text-[13px]' : 'text-[15px] leading-relaxed'}`}
        >
          {text}
        </button>
      )}
      {item.pending ? (
        <div className="text-[11px] text-faint">Sending…</div>
      ) : text && (
        <div className={`flex h-7 items-center gap-0.5 text-[11px] text-faint transition-opacity ${actions ? 'opacity-100' : 'opacity-0 group-hover/user:opacity-100'}`}>
          {item.timestamp && <span className="mr-1">{clockTime(item.timestamp)}</span>}
          <button type="button" aria-label="Copy" title="Copy" className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy className="size-3.5" />
          </button>
          {onEdit && !item.command && (
            <button type="button" aria-label="Edit and resend" title="Edit and resend: branches the conversation here" className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg" onClick={() => onEdit(item.key, item.text)}>
              <Pencil className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

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
      <button type="button" className="flex min-h-7 items-center gap-2 text-left hover:text-fg" onClick={() => setOpen((v) => !v)}>
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
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${run.permissions.length > 0 ? 'bg-wait' : 'bg-run'}`} />
            <span className={`relative inline-flex size-2 rounded-full ${run.permissions.length > 0 ? 'bg-wait' : 'bg-run'}`} />
          </span>
          <span className="shimmer-text">{run.permissions.length > 0 ? 'Waiting for you' : 'Working'}</span>
          <span className="text-faint tabular-nums">{duration(now - since)}</span>
        </div>
      )}
    </div>
  );
}

export function MessageList({
  sessionId, view, cwd, mode, onEdit,
}: { sessionId: string; view: SessionView; cwd?: string; mode: ViewMode; onEdit?: (uuid: string, text: string) => void }) {
  const items = useMemo(() => buildItems(view.messages), [view.messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const busy = Boolean(view.run?.busy);
  const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')?.key;

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
    if (snapshot.current) {
      el.scrollTop = snapshot.current.top + (el.scrollHeight - snapshot.current.height);
      snapshot.current = undefined;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, view.run?.partial, mode]);

  useEffect(() => {
    atBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
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

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowJump(!bottom);
    loadIfNearTop();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]">
        <div className="mx-auto max-w-3xl px-4 pt-3 pb-6">
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
                  return <UserBubble key={item.key} item={item} {...(onEdit ? { onEdit } : {})} />;
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
          className="animate-fade absolute bottom-3 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-line bg-panel shadow-md"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  );
}

import { ArrowDown, Brain, ChevronRight, Layers, Loader2, RotateCcw, SquareTerminal, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { PartialBlock, RunState } from '../../shared/protocol';
import { clockTime, dayLabel, duration } from '../lib/format';
import { loadOlder, type SessionView } from '../lib/store';
import { describeTool } from '../lib/tools';
import { buildItems, type Item, type Part } from '../lib/turns';
import { CopyButton, Markdown } from './Markdown';
import { ToolCallView, ToolTarget } from './ToolCall';

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
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

function Steps({ parts, cwd, running }: { parts: Part[]; cwd?: string; running: boolean }) {
  const tools = parts.filter((p) => p.kind === 'tool').length;
  const [open, setOpen] = useState(false);
  const fold = !open && !running && parts.length > FOLD_AFTER;
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
          <ToolCallView key={part.key} call={part.call} cwd={cwd} running={running} />
        ) : part.kind === 'thinking' ? (
          <Thinking key={part.key} text={part.text} />
        ) : null,
      )}
    </div>
  );
}

const AssistantTurn = memo(function AssistantTurn({ item, cwd, running }: { item: Extract<Item, { kind: 'assistant' }>; cwd?: string; running: boolean }) {
  const segments = useMemo(() => segment(item.parts), [item.parts]);
  const lastText = [...item.parts].reverse().find((p) => p.kind === 'text');
  return (
    <div className="group/turn">
      {segments.map((seg) =>
        seg.kind === 'steps' ? (
          <Steps key={seg.key} parts={seg.parts} cwd={cwd} running={running} />
        ) : seg.kind === 'text' ? (
          <Markdown key={seg.key} text={seg.text} className="my-2" />
        ) : seg.image.source.type === 'base64' && !seg.image.omitted ? (
          <img key={seg.key} alt="" className="my-2 max-h-80 rounded-lg border border-line" src={`data:${seg.image.source.media_type};base64,${seg.image.source.data}`} />
        ) : null,
      )}
      {!running && lastText && lastText.kind === 'text' && (
        <div className="-ml-1.5 flex h-7 items-center gap-1 text-[11px] text-faint opacity-0 transition-opacity group-hover/turn:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton text={lastText.text} />
          {item.timestamp && <span>{clockTime(item.timestamp)}</span>}
        </div>
      )}
    </div>
  );
});

const UserBubble = memo(function UserBubble({ item }: { item: Extract<Item, { kind: 'user' }> }) {
  return (
    <div className={`flex flex-col items-end gap-1.5 ${item.pending ? 'opacity-60' : ''}`}>
      {item.images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.images.map((image, i) =>
            image.omitted ? null : (
              <img
                key={i}
                alt=""
                className="max-h-44 rounded-xl border border-line object-cover"
                src={image.source.type === 'base64' ? `data:${image.source.media_type};base64,${image.source.data}` : image.source.url}
              />
            ),
          )}
        </div>
      )}
      {item.command ? (
        <div className="max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 font-mono text-[13px]">
          {item.command.name} {item.command.args}
        </div>
      ) : item.text ? (
        <div className="max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
          {item.text}
        </div>
      ) : null}
      {item.pending && <div className="text-[11px] text-faint">Sending…</div>}
    </div>
  );
});

function Notice({ item }: { item: Extract<Item, { kind: 'notice' }> }) {
  const [open, setOpen] = useState(false);
  if (item.tone === 'interrupt') {
    return <div className="flex items-center gap-2 text-[12px] text-faint"><span className="h-px flex-1 bg-line" />Interrupted<span className="h-px flex-1 bg-line" /></div>;
  }
  if (item.tone === 'output') {
    return (
      <pre className="max-h-60 overflow-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted">{item.text}</pre>
    );
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

function Compacted({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="flex w-full items-center gap-2 text-[12px] text-faint hover:text-fg" onClick={() => setOpen((v) => !v)}>
        <span className="h-px flex-1 bg-line" />
        <RotateCcw className="size-3" />
        Earlier conversation summarized
        <span className="h-px flex-1 bg-line" />
      </button>
      {open && <div className="mt-2 rounded-xl border border-line bg-panel px-3 py-2"><Markdown text={summary} className="text-[13.5px]" /></div>}
    </div>
  );
}

function partialTarget(block: Extract<PartialBlock, { type: 'tool_use' }>): Record<string, unknown> {
  try {
    return JSON.parse(block.inputJson) as Record<string, unknown>;
  } catch {
    // Partial JSON: pull out the first string field so the row says what it is doing.
    const match = block.inputJson.match(/"(command|file_path|pattern|url|query|description)"\s*:\s*"((?:[^"\\]|\\.)*)/);
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
          <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-run opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-run" /></span>
          <span className="shimmer-text">Working</span>
          <span className="text-faint tabular-nums">{duration(now - since)}</span>
        </div>
      )}
    </div>
  );
}

export function MessageList({ sessionId, view, cwd }: { sessionId: string; view: SessionView; cwd?: string }) {
  const items = useMemo(() => buildItems(view.messages), [view.messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevHeight = useRef<number | undefined>(undefined);
  const busy = Boolean(view.run?.busy);
  const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')?.key;

  // Keep the newest content in view while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current !== undefined) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = undefined;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, view.run?.partial]);

  useEffect(() => {
    atBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowJump(!bottom);
    if (el.scrollTop < 300 && view.offset > 0 && !view.loadingOlder) {
      prevHeight.current = el.scrollHeight;
      void loadOlder(sessionId);
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-4 pt-3 pb-6">
          {view.offset > 0 && (
            <div className="flex justify-center py-3 text-[12px] text-faint">
              {view.loadingOlder ? <Loader2 className="size-4 animate-spin" /> : `${view.offset} earlier messages`}
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
            {items.map((item) => {
              switch (item.kind) {
                case 'user':
                  return <UserBubble key={item.key} item={item} />;
                case 'assistant':
                  return <AssistantTurn key={item.key} item={item} cwd={cwd} running={busy && item.key === lastAssistant} />;
                case 'notice':
                  return <Notice key={item.key} item={item} />;
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

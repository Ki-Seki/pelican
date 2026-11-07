import { ArrowDown, Brain, ChevronRight, FileDiff, Layers, Loader2, MoreHorizontal, Paperclip, RotateCcw, SquareTerminal, TriangleAlert } from 'lucide-react';
import { Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ImageBlock, LiveShell, PartialBlock, RunState, SavedOutputPage, TurnChanges } from '../../shared/protocol';
import { requestShown } from '../../shared/requests';
import { api, apiUrl } from '../lib/api';
import { modelName } from '../../shared/usage';
import { entries, type MenuEntry, PROMPT_ACTIONS, type PromptTarget, REPLY_ACTIONS, type ReplyTarget, STEP_ACTIONS } from '../lib/actions';
import { addWaiting } from '../lib/drafts';
import { announce } from '../lib/announce';
import { clockTime, dayLabel, duration } from '../lib/format';
import { useMedia } from '../lib/media';
import { type Press, useLongPress, useRightClick } from '../lib/press';
import { promptGist, quoteItem, TOO_MANY_REPLIES } from '../lib/quote';
import { readPrCreated } from '../lib/requests';
import { promptBefore } from '../lib/next-steps';
import { usePathLinks } from '../lib/path-links';
import type { ViewMode } from '../lib/prefs';
import { SessionContext } from '../lib/session-context';
import { markStopping, useLiveShells } from '../lib/shells';
import { loadOlder, type SessionView } from '../lib/store';
import { InReply } from '../lib/terminals';
import { describeTool } from '../lib/tools';
import { buildItems, cleanOutput, filesChangedUnder, type Item, type Part, type SentFile } from '../lib/turns';
import { openImage } from './Lightbox';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { loadsInPlace, Markdown, RemoteImage } from './Markdown';
import { PrCard } from './PrCard';
import { PromptBody, QuoteTargetContext, SelectionActions, SwipeQuote } from './Quotes';
import { type RewindPoint, RewoundMarker } from './Rewind';
import { StreamingMarkdown } from './StreamingMarkdown';
import { sentFilesOf, ToolCallView, ToolTarget, useCommandTarget } from './ToolCall';
import { WorkflowEnded } from './WorkflowCard';

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

type Segment = { kind: 'steps'; key: string; parts: Part[] } | Extract<Part, { kind: 'text' | 'image' }> | { kind: 'card'; key: string; part: Extract<Part, { kind: 'tool' }> };

/**
 * Runs of tool calls and thinking become one block of steps between Claude's prose. A workflow,
 * and the files Claude sent, are cards of their own, never folded away among the steps.
 */
function segment(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    if (part.kind === 'tool' && (part.call.name === 'Workflow' || sentFilesOf(part.call).length > 0)) {
      out.push({ kind: 'card', key: part.key, part });
    } else if (part.kind === 'tool' || part.kind === 'thinking') {
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

/** Under a turn that changed files: how many, with the lines, opening that turn's changes. */
function TurnFiles({ turn, inline = false }: { turn: TurnChanges; inline?: boolean }) {
  const openTurn = usePathLinks()?.openTurn;
  if (!openTurn) return null;
  const added = turn.files.reduce((sum, f) => sum + f.added, 0);
  const removed = turn.files.reduce((sum, f) => sum + f.removed, 0);
  return (
    <button type="button" onClick={() => openTurn(turn.uuid)} className={`flex items-center gap-1.5 rounded-md text-[12.5px] text-muted hover:text-fg ${inline ? 'relative min-h-9 after:absolute after:-inset-y-1 after:inset-x-0' : '-mt-2 min-h-8'}`}>
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

/** A menu on a thing in the conversation, where it was asked for: at the pointer, under a button, or raised for a finger. */
type MenuAt = { at: MenuAnchor; lift?: Element; keys?: boolean };

/** Where a press opens a thing's menu: a finger's raises the thing, a right-click opens at the pointer, the menu key under it. */
const menuAt = (press: Press, lift?: Element): MenuAt => (press.pointerType === 'touch' || press.pointerType === 'pen'
  ? { at: press.element, lift: lift ?? press.element }
  : press.pointerType === 'keyboard' ? { at: press.element, keys: true } : { at: { x: press.x, y: press.y } });

/** Links and pictures keep the browser's own menu. */
const browsersOwn = (target: Element) => Boolean(target.closest('a[href]:not([data-path-link]), img, video, audio'));

/** A quiet icon button in a row of actions: 44 px under a finger. */
const ROW_BUTTON = 'relative grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg after:absolute after:-inset-1.5 [@media(hover:none)]:size-9 [@media(hover:none)]:after:-inset-1';

/** A row of a thing's own actions, as icons with their names in tooltips. */
function IconRow({ list, className = '' }: { list: MenuEntry[]; className?: string }) {
  return (
    <>
      {list.map((entry) => entry.icon && 'run' in entry && (
        <button key={entry.id} type="button" aria-label={entry.label} title={entry.label} onClick={entry.run} className={`${ROW_BUTTON} ${className}`}>
          <entry.icon className="size-3.5" />
        </button>
      ))}
    </>
  );
}

/** Where a turn ends, quietly: the turn's model, its time, and the last turn's figures. */
function figures(model: string | undefined, timestamp: number | undefined, stats: RunState['lastTurn'] | undefined, withTime: boolean): string[] {
  return [
    model ? modelName(model) : '',
    withTime && timestamp ? clockTime(timestamp) : '',
    stats ? duration(stats.durationMs) : '',
    stats?.outputTokens ? `${stats.outputTokens >= 1000 ? `${(stats.outputTokens / 1000).toFixed(1)}k` : stats.outputTokens} tokens out` : '',
    stats?.costUsd ? `$${stats.costUsd.toFixed(2)}` : '',
  ].filter(Boolean);
}

const AssistantTurn = memo(function AssistantTurn({
  item, cwd, running, view, stats, changed, onRewind, onFork,
}: {
  item: Extract<Item, { kind: 'assistant' }>;
  cwd?: string;
  running: boolean;
  view: ViewMode;
  stats?: RunState['lastTurn'];
  /** What the turn changed in files: at the end of its row on a phone, under it on a computer. */
  changed?: TurnChanges;
  /** Rewind to here and Fork from here, which act on the turn's prompt, as Desktop's message menu does. */
  onRewind?: () => void;
  onFork?: () => void;
}) {
  // Claude's thinking shows from the Thinking view on, as in Desktop.
  const segments = useMemo(() => segment(view === 'normal' ? item.parts.filter((p) => p.kind !== 'thinking') : item.parts), [item.parts, view]);
  const texts = item.parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text');
  const target = useContext(QuoteTargetContext);
  const box = useRef<HTMLDivElement>(null);
  const touch = useMedia('(hover: none)');
  const [menu, setMenu] = useState<MenuAt & { selection?: string; code?: string }>();

  // The reply as it reads, from its words on the page; as Claude wrote it, its Markdown.
  const reads = () => [...(box.current?.querySelectorAll<HTMLElement>('[data-reply-text]') ?? [])].map((el) => el.innerText.trim()).filter(Boolean).join('\n\n');
  const markdown = texts.map((t) => t.text).join('\n\n');
  const quote = (passage: string) => {
    if (!target) return;
    const quoted = quoteItem(passage, { what: target.side ? 'side' : 'reply', key: item.key, ...(item.timestamp ? { at: item.timestamp } : {}) });
    if (!quoted) return;
    if (addWaiting(target.chat, quoted)) announce('Quoted in your message');
    else announce(TOO_MANY_REPLIES);
  };
  const replyTarget = (selection?: string, code?: string): ReplyTarget => ({
    get text() {
      return reads() || markdown;
    },
    markdown,
    ...(selection ? { selection } : {}),
    ...(code ? { code } : {}),
    ...(target?.sideChat ? {
      sideChatOpen: target.sideChat.open,
      sideChat: (passage?: string) => {
        const quoted = quoteItem(passage || reads() || markdown, { what: 'reply', key: item.key });
        if (quoted) target.sideChat?.start(quoted);
      },
    } : {}),
    ...(target ? { quote } : {}),
    ...(onRewind ? { rewind: onRewind } : {}),
    ...(onFork ? { fork: onFork } : {}),
  });

  // A right-click puts what was clicked first: a selection in the reply, a code block; a path has
  // its own menu, and links and pictures keep the browser's.
  const right = useRightClick<HTMLDivElement>((press) => {
    const chosen = typeof getSelection === 'function' ? getSelection() : null;
    const inside = Boolean(chosen && !chosen.isCollapsed && chosen.anchorNode && box.current?.contains(chosen.anchorNode));
    const selection = inside ? chosen!.toString().trim() : undefined;
    const code = press.target.closest('pre')?.textContent ?? undefined;
    setMenu({ ...menuAt(press), ...(selection ? { selection } : {}), ...(code ? { code } : {}) });
  }, browsersOwn);

  const device = touch ? 'touch' : 'pointer';
  const list = menu ? entries(REPLY_ACTIONS, replyTarget(menu.selection, menu.code), 'menu', device) : [];
  const row = entries(REPLY_ACTIONS, replyTarget(), 'row', device);
  const more = useRef<HTMLButtonElement>(null);
  const said = figures(item.model, item.timestamp, stats, !touch);

  return (
    <div
      ref={box}
      className="group/turn"
      data-quotable
      data-quote-from={item.key}
      data-quote-what="reply"
      {...(item.timestamp ? { 'data-quote-at': item.timestamp } : {})}
      onPointerDown={right.onPointerDown}
      onContextMenu={right.onContextMenu}
    >
      <TurnHeading />
      {segments.map((seg) =>
        seg.kind === 'steps' ? (
          <Steps key={seg.key} parts={seg.parts} cwd={cwd} running={running} view={view} />
        ) : seg.kind === 'card' ? (
          <ToolCallView key={seg.key} call={seg.part.call} cwd={cwd} running={running} defaultOpen={view === 'verbose'} />
        ) : seg.kind === 'text' ? (
          // A paragraph swiped to the left is quoted (a phone's swipe to reply); a shell command in
          // Claude's own words can be run in the terminal.
          <ReplyText key={seg.key} text={seg.text} />
        ) : seg.image.omitted ? null : !loadsInPlace(imageSrc(seg.image)) ? (
          <div key={seg.key} className="my-2"><RemoteImage src={imageSrc(seg.image)} /></div>
        ) : (
          <button key={seg.key} type="button" aria-label="Open image" className="my-2 block" onClick={() => openImage(imageSrc(seg.image))}>
            <img alt="" loading="lazy" decoding="async" className="max-h-80 rounded-lg border border-line" src={imageSrc(seg.image)} />
          </button>
        ),
      )}
      {!running && texts.length > 0 && (
        // Always there on a phone; with a pointer on hover or focus, in room kept for it, so nothing moves.
        <div className={`-ml-1.5 flex min-h-7 items-center gap-0.5 text-[11.5px] text-faint ${menu ? '' : '[@media(hover:hover)]:opacity-0'} [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-focus-within/turn:opacity-100 [@media(hover:hover)]:group-hover/turn:opacity-100 [@media(hover:none)]:min-h-9`}>
          <IconRow list={row} />
          <button
            ref={more}
            type="button"
            aria-label="More for Claude’s reply"
            title="More"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={(e) => setMenu({ at: e.currentTarget, ...(e.detail === 0 ? { keys: true } : {}) })}
            className={ROW_BUTTON}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
          {/* The model and the time; the last turn's figures are in its menu. */}
          <span className="ml-1 truncate tabular-nums">{touch ? (item.timestamp ? clockTime(item.timestamp) : '') : [item.model ? modelName(item.model) : '', item.timestamp ? clockTime(item.timestamp) : ''].filter(Boolean).join(' · ')}</span>
          {touch && changed && <span className="ml-auto pl-2"><TurnFiles turn={changed} inline /></span>}
        </div>
      )}
      <ActionMenu
        open={Boolean(menu)}
        onClose={() => setMenu(undefined)}
        label="Claude’s reply"
        title={`Claude’s reply${item.timestamp ? ` · ${clockTime(item.timestamp)}` : ''}`}
        entries={list}
        at={menu?.at ?? null}
        focusFirst={Boolean(menu?.keys)}
        {...(said.length > 0 ? { footer: touch ? said.filter((part) => part !== (item.timestamp ? clockTime(item.timestamp) : '')).join(' · ') : said.join(' · ') } : {})}
      />
    </div>
  );
});

/**
 * Claude's own words in a reply: a paragraph swiped to the left is quoted (a phone's swipe to
 * reply), a shell command can be run in the terminal, and a pull request named in Desktop's
 * `<pr-created>` tag is a card under them.
 */
function ReplyText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const read = useMemo(() => readPrCreated(text, streaming), [text, streaming]);
  const words = read.text.trim() !== '' && (
    <InReply.Provider value>
      {streaming ? <StreamingMarkdown text={read.text} className="my-2" /> : <div data-reply-text><Markdown text={read.text} className="my-2" /></div>}
    </InReply.Provider>
  );
  return (
    <>
      {words && (streaming ? words : <SwipeQuote>{words}</SwipeQuote>)}
      {read.prs.map((pr) => <PrCard key={pr.url} pr={pr} />)}
    </>
  );
}

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
function PromptText({ text, command, onTap, source, press, bubble }: {
  text: string;
  command: boolean;
  onTap: () => void;
  source: { key: string; at?: number };
  /** A long press and a right-click open the prompt's list. */
  press: ReturnType<typeof useLongPress<HTMLDivElement>>;
  bubble: React.RefObject<HTMLDivElement | null>;
}) {
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
      ref={bubble}
      {...press}
      onClick={() => {
        // A tap, not the end of selecting some of it.
        if (matches('(hover: none)') && !getSelection()?.toString()) onTap();
      }}
      data-quotable
      data-quote-from={source.key}
      data-quote-what="prompt"
      {...(source.at ? { 'data-quote-at': source.at } : {})}
      className={`max-w-full rounded-2xl bg-chip px-3.5 py-2 break-words ${command ? 'font-mono text-[13px]' : 'text-[15px] leading-relaxed'} ${press.className}`}
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

/** A prompt as Rewind to here names it: its id, and its words in a few, as a title says them. */
const rewindPoint = (item: Extract<Item, { kind: 'user' }>): RewindPoint => ({
  uuid: item.key,
  text: promptGist(item.text).trim() || item.files.map((file) => file.name).join(', ') || (item.images.length > 0 ? 'A picture' : ''),
  ...(item.timestamp ? { timestamp: item.timestamp } : {}),
});

// The prompt's actions under a finger: labelled pills, laid out only once the prompt is tapped, so a
// prompt sits as close to its answer as any other item.
const PILL = 'relative flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-muted after:absolute after:-inset-y-1 after:inset-x-0 active:bg-hover';

const UserBubble = memo(function UserBubble({
  item, onRewind, onFork,
}: {
  item: Extract<Item, { kind: 'user' }>;
  /** Rewind to here: back to before it, its words back in the box (Chat asks first, as Desktop does). */
  onRewind?: (point: RewindPoint) => void;
  /** Fork from here: a new session up to just before it, its words in that session's box. */
  onFork?: (prompt: Extract<Item, { kind: 'user' }>) => void;
}) {
  const [actions, setActions] = useState(false);
  const [menu, setMenu] = useState<MenuAt>();
  // Select text, picked under a finger: its words take the system's own long press again.
  const [selectable, setSelectable] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  const target = useContext(QuoteTargetContext);
  const touch = useMedia('(hover: none)');
  const text = item.command ? `${item.command.name} ${item.command.args}`.trim() : item.text;
  // Desktop's Create PR request reads as the command it shows: /create-pr, /create-pr --draft.
  const request = item.command ? undefined : requestShown(item.text);
  const ready = !item.pending;
  const press = useLongPress<HTMLDivElement>((p) => ready && setMenu(menuAt(p)), { enabled: ready && !selectable, nativeMenu: browsersOwn, selectable });
  // Gone (a tap elsewhere took the selection), its words are a prompt's again, a long press its list.
  useEffect(() => {
    if (!selectable) return undefined;
    const onChange = () => {
      const now = getSelection();
      if (!now || now.isCollapsed || !bubble.current?.contains(now.anchorNode)) setSelectable(false);
    };
    const timer = setTimeout(() => document.addEventListener('selectionchange', onChange), 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [selectable]);
  const from = { what: 'prompt' as const, key: item.key, ...(item.timestamp ? { at: item.timestamp } : {}) };
  const prompt: PromptTarget = {
    text,
    ...(target ? {
      quote: () => {
        const quoted = quoteItem(text, from);
        if (quoted && addWaiting(target.chat, quoted)) announce('Quoted in your message');
        else if (quoted) announce(TOO_MANY_REPLIES);
      },
    } : {}),
    // A prompt that started its turn: one sent while Claude worked is part of another's.
    ...(onRewind && !item.command && !item.steered ? { rewind: () => onRewind(rewindPoint(item)) } : {}),
    ...(onFork && !item.command ? { fork: () => onFork(item) } : {}),
    selectText: () => {
      setSelectable(true);
      // The words selected whole, with the system's handles, for the selection's own actions.
      requestAnimationFrame(() => {
        const el = bubble.current?.firstElementChild;
        const selection = getSelection();
        if (!el || !selection) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    },
  };
  const device = touch ? 'touch' : 'pointer';
  const row = ready ? entries(PROMPT_ACTIONS, prompt, 'row', device) : [];
  const list = menu ? entries(PROMPT_ACTIONS, prompt, 'menu', device) : [];
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
      {text && (
        // Swiped to the left, it is quoted. With a pointer its actions show in the empty gutter
        // beside it, on hover or focus, adding no height.
        <SwipeQuote whole={{ from: () => from }} className="relative flex max-w-[85%] flex-col items-end">
          {!touch && row.length > 0 && (
            <div className="pointer-events-none absolute top-1 right-full mr-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100 group-hover/user:pointer-events-auto group-hover/user:opacity-100">
              <IconRow list={row} />
            </div>
          )}
          <PromptText text={request ?? text} command={Boolean(item.command || request)} onTap={() => ready && setActions((v) => !v)} source={from} press={press} bubble={bubble} />
        </SwipeQuote>
      )}
      {item.pending ? (
        <div className="text-[11px] text-faint">{item.queued ? 'Queued · sent when this turn ends' : 'Sending…'}</div>
      ) : text && touch && actions && (
        // A tap shows them, labelled; its long press's sheet says when it was sent.
        <div className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-faint">
          {row.map((entry) => entry.icon && 'run' in entry && (
            <button key={entry.id} type="button" onClick={() => {
              setActions(false);
              entry.run();
            }} className={PILL}>
              <entry.icon className="size-3.5" />{entry.label}
            </button>
          ))}
        </div>
      )}
      <ActionMenu
        open={Boolean(menu)}
        onClose={() => setMenu(undefined)}
        label="Your message"
        title={`Your message${item.timestamp ? ` · ${clockTime(item.timestamp)}` : ''}${item.steered ? ' · while Claude worked' : ''}`}
        entries={list}
        at={menu?.at ?? null}
        focusFirst={Boolean(menu?.keys)}
        {...(menu?.lift ? { lift: menu.lift } : {})}
      />
    </div>
  );
});

/** `onNext`: the next step an error line offers, where it ends the conversation (Retry, or Compact). */
function Notice({ item, onNext }: { item: Extract<Item, { kind: 'notice' }>; onNext?: () => void }) {
  const [open, setOpen] = useState(false);
  if (item.workflow) return <WorkflowEnded {...item.workflow} />;
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
 * All of a long output Claude Code saved in a file in place of the conversation (`name`, in the
 * session's tool-results folder), read once it is asked for (`sessionId` set), a page at a time.
 */
function useSavedOutput(sessionId: string | undefined, name: string | undefined) {
  const [pages, setPages] = useState<SavedOutputPage[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const load = useCallback((from: number) => {
    if (!sessionId || !name) return;
    setState('loading');
    api.savedOutput(sessionId, name, from).then((page) => {
      setPages((all) => ((all.length === 0 ? page.from === 0 : all.at(-1)?.next === page.from) ? [...all, page] : all));
      setState('idle');
    }, () => setState('failed'));
  }, [sessionId, name]);
  const asked = Boolean(sessionId && name);
  useEffect(() => {
    if (asked && pages.length === 0 && state === 'idle') load(0);
  }, [asked, pages.length, state, load]);
  const next = pages.at(-1)?.next;
  return {
    text: pages.length > 0 ? pages.map((page) => page.text).join('') : undefined,
    more: next !== undefined ? () => { if (state !== 'loading') load(next); } : undefined,
    loading: state === 'loading',
    failed: state === 'failed',
  };
}

/**
 * A `!` command someone ran in the session, with its output. A long output shows its end, the
 * result, as the command's live card did while it ran; Show all shows it from the start, and for
 * one Claude Code saved to a file (too long for the conversation), all of it, from that file, a
 * page at a time. One that failed or was stopped says so where its live card said how it ended.
 */
function ShellItem({ item, sessionId }: { item: Extract<Item, { kind: 'shell' }>; sessionId: string | undefined }) {
  const [all, setAll] = useState(false);
  const saved = useSavedOutput(all ? sessionId : undefined, item.saved);
  const recorded = useMemo(() => [item.stdout, item.stderr].map(cleanOutput).filter((part) => part.trim()).join('\n').replace(/^\s*\n/, '').trimEnd(), [item.stdout, item.stderr]);
  // A command's own list, as a command step has (lib/actions): a long press, a right-click, ⋯.
  const [menu, setMenu] = useState<MenuAt>();
  const touch = useMedia('(hover: none)');
  const target = useCommandTarget(item.command, recorded, item.key);
  const press = useLongPress<HTMLDivElement>((p) => setMenu(menuAt(p, p.element)), { nativeMenu: browsersOwn });
  const whole = useMemo(() => (saved.text === undefined ? undefined : cleanOutput(saved.text).replace(/^\s*\n/, '').trimEnd()), [saved.text]);
  const output = all && whole !== undefined ? whole : recorded;
  const lines = recorded.split('\n');
  const long = Boolean(item.saved) || lines.length > 14 || recorded.length > 1600;
  const clipped = long && !all;
  const foot = 'border-t border-line py-1.5 text-[12px] text-faint hover:text-fg';
  return (
    <div data-quotable data-quote-from={item.key} data-quote-what="step" {...(item.timestamp ? { 'data-quote-at': item.timestamp } : {})} className="group/shell overflow-hidden rounded-xl border border-line bg-panel">
      <div
        {...press}
        // Its own list, not the turn's it may sit in.
        onContextMenu={(e) => {
          press.onContextMenu(e);
          e.stopPropagation();
        }}
        className={`flex items-center gap-2 px-3 py-2 font-mono text-[12.5px] ${press.className}`}
      >
        <SquareTerminal className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 break-words">{item.command}</span>
        {item.ended && <span className="shrink-0 font-sans text-[11px] text-faint">{item.ended === 'stopped' ? 'Stopped' : 'Failed'}</span>}
        {item.timestamp && <span className="shrink-0 font-sans text-[11px] text-faint">{clockTime(item.timestamp)}</span>}
        <button
          type="button"
          aria-label={`More for ${commandName(item.command)}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={(e) => setMenu({ at: e.currentTarget, ...(e.detail === 0 ? { keys: true } : {}) })}
          className={`-my-1 hidden size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/shell:opacity-100 pointer-fine:grid ${menu ? 'opacity-100' : ''}`}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>
      <ActionMenu
        open={Boolean(menu)}
        onClose={() => setMenu(undefined)}
        label={`Run ${commandName(item.command)}`}
        title={<>Run · <span className="font-mono">{commandName(item.command)}</span></>}
        entries={menu ? entries(STEP_ACTIONS, target, 'menu', touch ? 'touch' : 'pointer') : []}
        at={menu?.at ?? null}
        focusFirst={Boolean(menu?.keys)}
        {...(menu?.lift ? { lift: menu.lift } : {})}
      />
      {output && (
        // Clipped, its last lines sit at the bottom of the box, the start fading out above them.
        <pre className={`border-t border-line px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted ${clipped ? 'flex max-h-60 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_top,black_75%,transparent)]' : ''}`}>
          <span>{clipped ? output.split('\n').slice(-TAIL_LINES).join('\n') : output}</span>
        </pre>
      )}
      {all && item.saved && (saved.failed || (saved.loading && whole === undefined)) && (
        <div className="border-t border-line px-3 py-1.5 text-[12px] text-faint">{saved.failed ? 'The saved output is gone; this is its start' : 'Reading the saved output…'}</div>
      )}
      {long && (
        <div className="flex">
          <button type="button" aria-expanded={all} className={`flex-1 ${foot}`} onClick={() => setAll((v) => !v)}>
            {all ? 'Show less' : 'Show all'}
          </button>
          {all && saved.more && (
            <button type="button" disabled={saved.loading} className={`flex-1 border-l ${foot} disabled:opacity-50`} onClick={saved.more}>
              Show more
            </button>
          )}
        </div>
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

/** The start of a JSON string still streaming in, its escapes undone, up to where it has come. */
function jsonStringStart(raw: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += escapes[next] ?? next;
      i += 1;
    }
  }
  return out;
}

function partialTarget(block: Extract<PartialBlock, { type: 'tool_use' }>): Record<string, unknown> {
  try {
    return JSON.parse(block.inputJson) as Record<string, unknown>;
  } catch {
    // A workflow's script, as far as it came: its meta names it.
    const script = block.name === 'Workflow' ? /"script"\s*:\s*"/.exec(block.inputJson) : null;
    if (script) return { script: jsonStringStart(block.inputJson.slice(script.index + script[0].length)) };
    // Partial JSON: pull out the first string field so the row says what it is doing.
    const match = block.inputJson.match(/"(description|command|file_path|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (match) return { [match[1]!]: match[2]!.replace(/\\n/g, ' ') };
    // A file being sent, by the first name written so far.
    const file = /"files"\s*:\s*\[?\s*"((?:[^"\\]|\\.)*)/.exec(block.inputJson);
    return file ? { files: [file[1]!] } : {};
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
        if (block.type === 'text') return block.text ? <ReplyText key={i} text={block.text} streaming /> : null;
        // Normal says that Claude thinks; the other views show what, as it comes.
        if (block.type === 'thinking') return <Thinking key={i} text={view === 'normal' ? '' : block.thinking} live defaultOpen />;
        const summary = describeTool(block.name, partialTarget(block), cwd);
        const Icon = summary.icon;
        return (
          // Laid out as a finished step's row (ToolCall): a long command is cut, never the icon or the verb.
          <div key={i} data-step-writing className="flex min-h-8 min-w-0 items-center gap-2 text-[13px] text-muted">
            <Icon className="size-3.5 shrink-0" />
            <span className="shrink-0 text-fg/80">{summary.running ?? summary.verb}</span>
            {summary.target && <ToolTarget summary={summary} />}
            <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-faint" />
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
  sessionId, view, cwd, machine, mode, onRewind, onUndoRewind, onFork, onForkReply, onRetry, onCompact,
}: {
  sessionId: string;
  view: SessionView;
  cwd?: string;
  /** The computer Claude Code runs on, for error lines that say what to do there. */
  machine?: string;
  mode: ViewMode;
  /** Rewind to here, on a prompt or a reply (which acts on its turn's prompt). */
  onRewind?: (point: RewindPoint) => void;
  /** Undo rewind, at the marker where the conversation was rewound. */
  onUndoRewind?: () => Promise<void>;
  /** Fork from a prompt: a new session up to just before it, its words in that session's box. */
  onFork?: (prompt: Extract<Item, { kind: 'user' }>) => void;
  /** Fork from a reply: a new session up to the end of it (`upTo`, its last message). */
  onForkReply?: (upTo: string) => void;
  /** The next step on an API error that ends the conversation: send its prompt again, or /compact. */
  onRetry?: (prompt: Extract<Item, { kind: 'user' }>) => void;
  onCompact?: () => void;
}) {
  const items = useMemo(() => buildItems(view.messages, machine), [view.messages, machine]);
  // Under a finger, a turn's "files changed" ends its row; with a pointer it sits under the turn.
  const touchScreen = useMedia('(hover: none)');
  // A `!` command shows live until its record replaces it, under the same id.
  const shells = useLiveShells(sessionId);
  const live = useMemo(() => new Set(shells.map((shell) => shell.id)), [shells]);
  // The prompt this browser sent last, while it is on its way: sending always brings the end into view.
  const sending = useMemo(() => [...items].reverse().find((i) => i.kind === 'user' && i.pending)?.key, [items]);
  const lastSending = useRef<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // A phone's selection: its actions dock at the foot of the conversation, which makes room for them.
  const [docked, setDocked] = useState(false);
  /** Following the newest output. Stops the moment the reader scrolls up or opens something; any other tap leaves it be. */
  const atBottom = useRef(true);
  /** A finger is on the list: never move it under them. */
  const touching = useRef(false);
  /** Something came while it was: the list catches up once the finger lifts, and only then. */
  const heldBack = useRef(false);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const busy = Boolean(view.run?.busy);
  const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')?.key;
  // Where the conversation was rewound: the marker sits at the end of what it kept, before anything sent since.
  const cutAt = view.rewound ? items.findIndex((i) => i.kind === 'user' && i.pending) : -1;
  const marker = view.rewound ? <RewoundMarker key="rewound" {...(onUndoRewind && cutAt < 0 ? { onUndo: onUndoRewind } : {})} /> : null;
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
    if (atBottom.current && !selecting) {
      if (touching.current) heldBack.current = true;
      else el.scrollTop = el.scrollHeight;
    }
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
      heldBack.current = false;
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
    <div ref={frame} className="relative min-h-0 flex-1">
      {/* Opening or closing something (a step, a long output) is reading, not following: what
          arrives next must not pull it away. A tap that opens nothing (selecting text, a link,
          Copy) leaves following as it was. Scrolling back down to the end follows again. */}
      <div
        ref={scroller}
        data-conversation
        onScroll={onScroll}
        onClickCapture={(e) => {
          if ((e.target as Element).closest?.('[aria-expanded], [aria-pressed], summary')) atBottom.current = false;
        }}
        onTouchStart={() => { touching.current = true; }}
        // A tap's own click comes after its finger lifts: a list that moved then would take it
        // from what was tapped. It moves only for what came while the finger was down.
        onTouchEnd={() => {
          touching.current = false;
          if (heldBack.current) settle();
          heldBack.current = false;
        }}
        onTouchCancel={() => {
          touching.current = false;
          if (heldBack.current) settle();
          heldBack.current = false;
        }}
        onWheel={(e) => { if (e.deltaY < 0) atBottom.current = false; }}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div ref={content} className={`relative mx-auto max-w-3xl px-4 pt-3 ${docked ? 'pb-20' : 'pb-6'}`}>
          <SelectionActions within={content} dockTo={frame} onDock={setDocked} />
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
              const here = at === cutAt ? marker : null;
              const shown = (() => { switch (item.kind) {
                case 'user':
                  return <UserBubble key={item.key} item={item} {...(onRewind ? { onRewind } : {})} {...(onFork ? { onFork } : {})} />;
                case 'shell':
                  return live.has(item.key) ? null : <ShellItem key={item.key} item={item} sessionId={sessionId} />;
                case 'assistant': {
                  const running = busy && item.key === lastAssistant;
                  const changed = running ? undefined : changedUnder.get(item.key);
                  // The turn's prompt, which its Rewind to here acts on; its own end, which Fork from here keeps.
                  const prompt = onRewind ? promptBefore(items, at) : undefined;
                  const end = item.parts.at(-1)?.key.split(':')[0];
                  return (
                    <Fragment key={item.key}>
                      <AssistantTurn
                        item={item}
                        cwd={cwd}
                        view={mode}
                        running={running}
                        {...(changed ? { changed } : {})}
                        {...(prompt && !prompt.command && !prompt.steered && onRewind ? { onRewind: () => onRewind(rewindPoint(prompt)) } : {})}
                        {...(end && onForkReply && !running ? { onFork: () => onForkReply(end) } : {})}
                        {...(item.key === lastAssistant && view.run?.lastTurn ? { stats: view.run.lastTurn } : {})}
                      />
                      {changed && !touchScreen && <TurnFiles turn={changed} />}
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
              } })();
              return here ? <Fragment key={item.key}>{here}{shown}</Fragment> : shown;
            })}
            {cutAt < 0 && marker}
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
      {/* While a finger's selection has its actions docked here, with the selection just above them, this waits. */}
      {showJump && !docked && (
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

import { useQuery } from '@tanstack/react-query';
import { Download, Loader2, Maximize2, Play } from 'lucide-react';
import { createContext, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

import { entries, LINES_ACTIONS, type LinesTarget } from '../lib/actions';
import { api, apiUrl } from '../lib/api';
import { rehypeCodeLines } from '../lib/code-lines';
import { formatBytes } from '../lib/format';
import { newId } from '../lib/ids';
import { markTipSeen, tipSeen } from '../lib/prefs';
import { ariaKeys, composing, hasKeyboard, isKey } from '../lib/keyboard';
import { quoteItem, quoteLines, type WaitingItem } from '../lib/quote';
import { commentsOf, lastLine, type LineComment, setComments, useComments, useCommentsChat } from '../lib/review';
import { CommentBox, CommentNote, useSendComments } from './Comments';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { useLineDrag, useLinePick, useLineSelection } from './line-pick';
import { Markdown } from './Markdown';
import { openPreview, Sandbox } from './Preview';

const LANGUAGE: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', scss: 'scss', html: 'html', htm: 'html', xml: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', php: 'php', lua: 'lua', vue: 'xml', svelte: 'xml',
};

/** Past this a file shows without highlighting: highlighting it all would hold the page up. */
const HIGHLIGHT_MAX = { chars: 200_000, lines: 6_000 };

/** Whether long lines wrap, as last chosen in this browser: the viewer is where it is chosen. */
const WRAP_KEY = 'pelican:wrap';
const wrapListeners = new Set<() => void>();
let wrapping = (() => {
  try {
    return localStorage.getItem(WRAP_KEY) !== 'off';
  } catch {
    return true;
  }
})();
function setWrapping(on: boolean): void {
  wrapping = on;
  try {
    localStorage.setItem(WRAP_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: it holds for this page.
  }
  for (const listener of wrapListeners) listener();
}
const useWrapping = () => useSyncExternalStore((l) => {
  wrapListeners.add(l);
  return () => wrapListeners.delete(l);
}, () => wrapping);

/** Lines picked by their numbers: the first and last, and where a Shift-click extends from. */
type Picked = { from: number; to: number; anchor: number };

/** What every line of the file needs to draw itself, shared through the highlighted lines. */
type Lines = {
  path: string;
  texts: readonly string[];
  digits: number;
  wrap: boolean;
  /** The line opened at (from a link, a search result). */
  target?: number;
  /** Lines picked by their numbers. */
  picked?: Picked;
  /** Comments, under the last line each is on. */
  comments: Map<number, LineComment[]>;
  /** The lines a comment is being written on; what is typed is the box's own (and `note`'s). */
  editing?: { from: number; to: number };
  note: { current: string };
  /** A tap or a click on a line: picks it, or with Shift extends what is picked to it. */
  pick: (line: number, extend: boolean) => void;
  /** The gutter's + with a pointer: a comment on the line at once, as Desktop's line number offers. */
  commentOn: (line: number) => void;
  save: (note: string, sendAll: boolean) => void;
  cancel: () => void;
  remove: (comment: LineComment) => void;
};

/** The comment being written: its text kept here, so typing redraws the box, not every line. */
function EditingBox({ lines }: { lines: Lines }) {
  const [note, setNote] = useState(lines.note.current);
  return (
    <CommentBox
      note={note}
      onNote={(value) => {
        lines.note.current = value;
        setNote(value);
      }}
      onSave={(now) => lines.save(note, now)}
      onCancel={lines.cancel}
    />
  );
}
const LinesContext = createContext<Lines | undefined>(undefined);

const within = (n: number, range: { from: number; to: number } | undefined) => Boolean(range && n >= range.from && n <= range.to);

/** One line: its number, its text (highlighted when it could be), its comments, a comment being written. */
function LineRow({ n, children }: { n: number; children?: ReactNode }) {
  const lines = useContext(LinesContext)!;
  const picked = within(n, lines.picked) || within(n, lines.editing);
  const marked = picked || lines.target === n;
  return (
    <div>
      <div
        data-line={n}
        onClick={(e) => lines.pick(n, e.shiftKey)}
        className={`group/line flex cursor-pointer ${picked ? 'bg-mark' : marked ? 'bg-hover shadow-[inset_3px_0_0_var(--fg)]' : 'pointer-fine:hover:shadow-[inset_3px_0_0_var(--faint)]'}`}
      >
        <span className={`relative shrink-0 pr-2.5 pl-2 text-right text-faint tabular-nums select-none ${lines.wrap ? '' : 'sticky left-0'} ${picked ? 'bg-mark text-fg' : lines.wrap ? '' : 'bg-bg'}`} style={{ width: `calc(${lines.digits}ch + 1.125rem)` }}>
          {n}
          {/* With a pointer, its number turns into Desktop's + on hover: a comment on the line at once. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Add comment on line ${n}`}
            onClick={(e) => {
              e.stopPropagation();
              lines.commentOn(n);
            }}
            className="absolute inset-y-0 right-1.5 my-auto hidden size-4 place-items-center rounded bg-fg text-[12px] leading-none font-medium text-bg pointer-fine:group-hover/line:grid"
          >
            +
          </button>
        </span>
        <span className={`min-w-0 flex-1 pr-3 ${lines.wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>{children ?? (lines.texts[n - 1] || ' ')}</span>
      </div>
      {lines.comments.get(n)?.map((c) => <CommentNote key={c.id} comment={c} onRemove={() => lines.remove(c)} />)}
      {lines.editing?.to === n && <EditingBox lines={lines} />}
    </div>
  );
}

const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const highlightComponents = {
  pre: Pass,
  code: Pass,
  'pelican-line': ({ node, children }: { node?: { properties?: Record<string, unknown> }; children?: ReactNode }) => <LineRow n={Number(node?.properties?.dataN)}>{children}</LineRow>,
} as unknown as Components;
const highlightPlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }], rehypeCodeLines] as never;

/** The file's lines highlighted, made once per text: what changes later reaches them through LinesContext. */
const Highlighted = memo(function Highlighted({ text, language }: { text: string; language: string }) {
  // A fence longer than any run of backticks in the text, so none of it can close the block.
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return <ReactMarkdown rehypePlugins={highlightPlugins} components={highlightComponents}>{`${fence}${language}\n${lastBreakOff(text)}\n${fence}`}</ReactMarkdown>;
});

/**
 * Where Changes and files puts a file's selection bar: a row of its own under what scrolls, so
 * the file never scrolls under it; `safe`: the lowest row of the view, clear of the home indicator
 * and level with the view's other lowest rows (Send now, and beside the conversation the message
 * boxes): 8px above the edge at least, on a phone and on a computer. A viewer with none keeps the
 * bar at the foot of the file as it scrolls.
 */
export type SelectionFootAt = { at: HTMLElement; safe?: boolean };
export const SelectionFoot = createContext<SelectionFootAt | undefined>(undefined);

/**
 * Where a quote taken in Changes and files goes: beside the conversation it waits above the message
 * box at once; on a phone it opens in place, for a note (the view's own sheet). Given by the view.
 */
export const PaneQuote = createContext<((item: WaitingItem) => void) | undefined>(undefined);

/** Under lines picked or selected: Copy · Quote · Add comment, one design wherever lines are (lib/actions). */
export function LinesBar({ target, place }: { target: LinesTarget; place: string }) {
  const list = entries(LINES_ACTIONS, target, 'row', hasKeyboard() ? 'pointer' : 'touch');
  return (
    <div data-lines-bar className={place}>
      <div role="toolbar" aria-label="Picked lines" className="flex h-11 items-center rounded-2xl border border-line bg-panel pr-1 pl-3.5 text-[14px] shadow-lg pointer-fine:h-9 pointer-fine:text-[13px]">
        <span className="min-w-0 flex-1 truncate text-muted tabular-nums">{target.to > target.from ? `Lines ${target.from}\u2013${target.to}` : `Line ${target.from}`}</span>
        {list.map((entry, i) => 'run' in entry && (
          <span key={entry.id} className="flex h-full items-center">
            {i > 0 && <span aria-hidden className="h-5 w-px bg-line" />}
            <button
              type="button"
              // The selection stays while the bar is pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={entry.run}
              {...(entry.key ? { 'aria-keyshortcuts': ariaKeys(entry.key) } : {})}
              className="flex h-full items-center gap-1.5 rounded-full px-3 hover:bg-hover"
            >
              {entry.icon && entry.id !== 'copy' && <entry.icon className="size-4 text-muted pointer-fine:size-3.5" />}
              {entry.label}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A file's text without the line break it ends with, which starts no line of its own, as in an editor. */
function lastBreakOff(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

const splitText = (text: string) => lastBreakOff(text).split('\n');

type FileViewerProps = {
  cwd: string;
  path: string;
  line?: number;
  /** `block`: on lines of its own (a request); `quote`: a quote, which waits above the message box. */
  onAddToMessage: (text: string, how?: 'block' | 'quote') => void;
};

/**
 * A file of the session's folder, to read: with line numbers, wrapped or not, opened at a line
 * when it was asked for one; Markdown and HTML also as they look (HTML in the sandboxed frame
 * where nothing runs until Run). Tap a line to comment on it for Claude, as on a diff; select
 * lines to quote them into the message, or copy them. Read only: Claude changes files.
 *
 * Each file gets a viewer of its own, also when a link goes straight from one to another: what
 * one had (Preview, Run, a comment being written) never carries over to the next.
 */
export function FileViewer(props: FileViewerProps) {
  return <OpenFile key={`${props.cwd}\0${props.path}`} {...props} />;
}

function OpenFile({ cwd, path, line, onAddToMessage }: FileViewerProps) {
  const { data, isLoading, error } = useQuery({ queryKey: ['file', cwd, path], queryFn: () => api.file(cwd, path), staleTime: 5_000 });
  const name = path.split('/').pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const previewable = ext === 'md' || ext === 'markdown' || ext === 'html' || ext === 'htm';
  // Markdown opens as it reads, unless a line was asked for; a page opens as its code.
  const [preview, setPreview] = useState(() => (ext === 'md' || ext === 'markdown') && !line);
  const wrap = useWrapping();
  const text = data?.text;
  // Run runs the page as it was when it was tapped: rewritten since (Claude edited it), it waits for Run again.
  const [ran, setRan] = useState<string>();
  const run = ran !== undefined && ran === text;
  const texts = useMemo(() => (text === undefined ? [] : splitText(text)), [text]);
  const chat = useCommentsChat(cwd);
  const all = useComments(chat);
  const mine = useMemo(() => all.filter((c) => c.path === path && c.kind !== 'del'), [all, path]);
  // Lines picked by their numbers, and the lines a comment is being written on: what is typed
  // follows a tap on other lines, so a missed line costs nothing.
  const [picked, setPicked] = useState<Picked>();
  const [editing, setEditing] = useState<{ from: number; to: number }>();
  const note = useRef('');
  const [showHint] = useState(() => !tipSeen('line-comments'));
  const sendAll = useSendComments();
  const foot = useContext(SelectionFoot);
  const quoteHere = useContext(PaneQuote);
  const box = useRef<HTMLDivElement | null>(null);
  // The lines' box, once it is there (the file loaded, shown as its source): where a finger picks.
  const [boxShown, setBoxShown] = useState<HTMLDivElement | null>(null);
  const selection = useLineSelection(box, 'data-line');
  const [menu, setMenu] = useState<{ at: MenuAnchor; keys: boolean }>();
  // A click on a line picks it: with a mouse once a double click (selecting a word) is ruled out.
  const pickOne = useLinePick((n: number) => {
    setPicked((was) => (was && was.from === n && was.to === n ? undefined : { from: n, to: n, anchor: n }));
  });
  const latest = useRef({ chat, path, texts, editing, sendAll, picked });
  latest.current = { chat, path, texts, editing, sendAll, picked };
  // Under a finger: a long press on a line, then a drag, picks the lines it goes over.
  useLineDrag(boxShown, 'data-line', (anchor, end) => setPicked({ from: Math.min(anchor, end), to: Math.max(anchor, end), anchor }));

  // Opening at a line: Source, the line in the middle of the view, marked.
  useEffect(() => {
    if (line) setPreview(false);
  }, [line]);
  useLayoutEffect(() => {
    if (!line || preview || texts.length === 0) return;
    box.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }, [line, preview, texts.length]);

  const { onLine, outdated } = useMemo(() => {
    const at = new Map<number, LineComment[]>();
    const gone: LineComment[] = [];
    for (const c of mine) {
      if (texts.slice(c.line - 1, lastLine(c)).join('\n') === c.code) at.set(lastLine(c), [...(at.get(lastLine(c)) ?? []), c]);
      else gone.push(c);
    }
    return { onLine: at, outdated: gone };
  }, [mine, texts]);
  /** A comment on lines `from` to `to`: Desktop's box under the last, the lines staying marked. */
  const commentOn = (from: number, to = from) => {
    note.current = '';
    setEditing({ from, to });
    setPicked(undefined);
    window.getSelection()?.removeAllRanges();
  };
  const lines = useMemo<Lines>(() => ({
    path,
    texts,
    digits: String(texts.length).length,
    wrap,
    ...(line ? { target: line } : {}),
    ...(picked ? { picked } : {}),
    comments: onLine,
    ...(editing ? { editing } : {}),
    note,
    pick: (n, extend) => {
      const was = latest.current.picked;
      if (extend && was) {
        // Shift-click: from where the picking started to this line, at once.
        setPicked({ from: Math.min(was.anchor, n), to: Math.max(was.anchor, n), anchor: was.anchor });
        window.getSelection()?.removeAllRanges();
        return;
      }
      pickOne(n);
    },
    commentOn: (n) => commentOn(n),
    save: (typed, now) => {
      const { chat: owner, path: file, texts: text, editing: at, sendAll: send } = latest.current;
      if (!at || !typed.trim()) return;
      setComments(owner, [...commentsOf(owner), { id: newId(), path: file, kind: 'same', line: at.from, ...(at.to > at.from ? { to: at.to } : {}), code: text.slice(at.from - 1, at.to).join('\n'), note: typed.trim() }]);
      note.current = '';
      setEditing(undefined);
      markTipSeen('line-comments');
      // The keys go back to the file's text, as on a diff, where Esc still closes the view.
      box.current?.focus({ preventScroll: true });
      if (now) send?.();
    },
    cancel: () => {
      note.current = '';
      setEditing(undefined);
      box.current?.focus({ preventScroll: true });
    },
    remove: (comment) => setComments(latest.current.chat, commentsOf(latest.current.chat).filter((c) => c.id !== comment.id)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [path, texts, wrap, line, onLine, editing, picked]);
  const language = LANGUAGE[ext];
  const highlight = text !== undefined && language && text.length <= HIGHLIGHT_MAX.chars && texts.length <= HIGHLIGHT_MAX.lines;

  // What the bar and a right-click act on: a selection with a mouse, else the lines picked.
  const range = selection ?? (picked ? { from: picked.from, to: picked.to } : undefined);
  /** Lines from..to as a quote: their path and lines go with them, as Desktop attaches a file's. */
  const quote = (from: number, to: number) => {
    const item = quoteItem(texts.slice(from - 1, to).join('\n'), { what: 'file' }, { path, lines: [from, to] });
    window.getSelection()?.removeAllRanges();
    setPicked(undefined);
    if (!item) return;
    if (quoteHere) quoteHere(item);
    else onAddToMessage(quoteLines(path, from, to, texts.slice(from - 1, to)), 'quote');
  };
  // Copy takes the lines themselves: a comment shown between them is not part of the file.
  const target = (at: { from: number; to: number; text?: string }): LinesTarget => ({
    from: at.from,
    to: at.to,
    text: at.text !== undefined && at.from === at.to ? at.text : texts.slice(at.from - 1, at.to).join('\n'),
    quote: () => quote(at.from, at.to),
    comment: () => commentOn(at.from, at.to),
  });
  const bar = range && !editing && ((place: string) => <LinesBar target={target(range)} place={place} />);

  // ⇧⌘L quotes the lines picked, as it quotes a selection; Esc lets them go, before it closes the view.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!range || composing(e.nativeEvent)) return;
    if (isKey(e, 'quoteSelection')) {
      e.preventDefault();
      e.stopPropagation();
      quote(range.from, range.to);
    } else if (e.key === 'Escape' && picked) {
      e.preventDefault();
      e.stopPropagation();
      setPicked(undefined);
    }
  };
  // A right-click on the lines: the bar's list, for what is picked, or the line clicked when it is not.
  const onContextMenu = (e: React.MouseEvent) => {
    const at = Number((e.target as Element).closest('[data-line]')?.getAttribute('data-line'));
    if (!at || !hasKeyboard()) return;
    e.preventDefault();
    if (!within(at, range)) setPicked({ from: at, to: at, anchor: at });
    setMenu({ at: { x: e.clientX, y: e.clientY }, keys: false });
  };
  const menuRange = range;

  const tool = 'flex h-9 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] text-muted hover:bg-hover hover:text-fg aria-pressed:text-fg';
  return (
    <div className="px-1 pb-4">
      {/* The tools wrap onto a second line rather than run off a narrow screen. */}
      <div className="mb-1.5 flex flex-wrap items-center justify-end gap-0.5 px-2">
        <span className="mr-auto shrink-0 pr-2 text-[12px] text-faint">{data ? formatBytes(data.size) : ''}</span>
        {text !== undefined && !preview && (
          <button type="button" aria-pressed={wrap} onClick={() => setWrapping(!wrap)} className={tool}>Wrap</button>
        )}
        {text !== undefined && previewable && (
          <button type="button" onClick={() => setPreview(!preview)} className={tool}>{preview ? 'Source' : 'Preview'}</button>
        )}
        <a href={apiUrl(`file/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)} download={name} className={tool}>
          <Download className="size-3.5" /> Download
        </a>
      </div>
      {isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
      {error && <div className="px-3 py-6 text-[13px] text-danger">{(error as Error).message}</div>}
      {data?.image && <img src={data.image} alt={path} className="mx-auto max-h-[70dvh] max-w-full rounded-lg border border-line" />}
      {data?.binary && <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file; nothing to show here</div>}
      {text !== undefined && preview && (ext === 'html' || ext === 'htm') && (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="flex h-9 items-center justify-end gap-1 border-b border-line px-1 text-[12px] text-faint">
            {!run && <button type="button" onClick={() => setRan(text)} title="Run its scripts" className="flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover hover:text-fg"><Play className="size-3.5" /> Run</button>}
            <button type="button" aria-label="Open full screen" onClick={() => openPreview({ kind: 'html', code: text, title: name }, run)} className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg"><Maximize2 className="size-3.5" /></button>
          </div>
          {/* A page's height is its own and a still frame cannot say it: the frame takes most of the screen. */}
          <div className="h-[min(70dvh,900px)] bg-bg"><Sandbox source={{ kind: 'html', code: text, title: name }} run={run} fill /></div>
        </div>
      )}
      {text !== undefined && preview && ext !== 'html' && ext !== 'htm' && <Markdown text={text} className="px-2" />}
      {text !== undefined && !preview && (
        <>
          {showHint && mine.length === 0 && (
            <p className="px-2 pb-1.5 text-[12px] text-faint">
              <span className="pointer-fine:hidden">Tap a line, or hold one and drag, to quote it or comment on it</span>
              <span className="hidden pointer-fine:inline">Click a line, or Shift-click to more, to quote it or comment on it</span>
            </p>
          )}
          {outdated.length > 0 && (
            <div className="mb-1.5 overflow-hidden rounded-lg border border-line">
              {outdated.map((c) => <CommentNote key={c.id} comment={c} outdated onRemove={() => lines.remove(c)} />)}
            </div>
          )}
          <LinesContext.Provider value={lines}>
            <div
              ref={(el) => {
                box.current = el;
                setBoxShown(el);
              }}
              role="group"
              tabIndex={-1}
              aria-label={`The text of ${path}`}
              onKeyDown={onKeyDown}
              onContextMenu={onContextMenu}
              style={{ WebkitTouchCallout: 'none' }}
              className={`rounded-lg border border-line font-mono text-[12px] leading-[1.6] [tab-size:4] [@media(hover:none)]:select-none ${wrap ? 'overflow-hidden' : 'overflow-x-auto'}`}
            >
              {highlight ? <Highlighted text={text} language={language} /> : texts.map((_, i) => <LineRow key={i} n={i + 1} />)}
            </div>
          </LinesContext.Provider>
          {bar && (foot ? createPortal(bar(`px-3 py-1.5 ${foot.safe ? 'pb-safe' : ''}`), foot.at) : bar('sticky bottom-0 z-10 -mx-1 px-2 py-1.5'))}
          <ActionMenu
            open={Boolean(menu)}
            onClose={() => setMenu(undefined)}
            label="Lines"
            entries={menu && menuRange ? entries(LINES_ACTIONS, target(menuRange), 'menu', 'pointer') : []}
            at={menu?.at ?? null}
            focusFirst={Boolean(menu?.keys)}
          />
        </>
      )}
      {data?.truncated && <div className="pt-2 text-center text-[12px] text-faint">Only the first 512 KB is shown</div>}
    </div>
  );
}


import { useQuery } from '@tanstack/react-query';
import { AtSign, Check, Copy, Download, Loader2, Maximize2, Play, Quote } from 'lucide-react';
import { createContext, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

import { api, apiUrl } from '../lib/api';
import { rehypeCodeLines } from '../lib/code-lines';
import { formatBytes } from '../lib/format';
import { newId } from '../lib/ids';
import { markTipSeen, tipSeen } from '../lib/prefs';
import { quoteLines } from '../lib/quote';
import { commentsOf, type LineComment, setComments, useComments, useCommentsChat } from '../lib/review';
import { CommentBox, CommentNote, useSendComments } from './Comments';
import { useLinePick } from './line-pick';
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

/** What every line of the file needs to draw itself, shared through the highlighted lines. */
type Lines = {
  path: string;
  texts: readonly string[];
  digits: number;
  wrap: boolean;
  /** The line opened at (from a link, a search result). */
  target?: number;
  comments: Map<number, LineComment[]>;
  /** The line a comment is being written on; what is typed is the box's own (and `note`'s). */
  editing?: number;
  note: { current: string };
  pick: (line: number) => void;
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

/** One line: its number, its text (highlighted when it could be), its comments, a comment being written. */
function LineRow({ n, children }: { n: number; children?: ReactNode }) {
  const lines = useContext(LinesContext)!;
  const marked = lines.target === n || lines.editing === n;
  return (
    <div>
      <div
        data-line={n}
        onClick={() => lines.pick(n)}
        className={`flex cursor-pointer ${marked ? 'bg-hover shadow-[inset_3px_0_0_var(--fg)]' : 'pointer-fine:hover:shadow-[inset_3px_0_0_var(--faint)]'}`}
      >
        <span className={`shrink-0 pr-2.5 pl-2 text-right text-faint tabular-nums select-none ${lines.wrap ? '' : 'sticky left-0 bg-bg'}`} style={{ width: `calc(${lines.digits}ch + 1.125rem)` }}>{n}</span>
        <span className={`min-w-0 flex-1 pr-3 ${lines.wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>{children ?? (lines.texts[n - 1] || ' ')}</span>
      </div>
      {lines.comments.get(n)?.map((c) => <CommentNote key={c.id} comment={c} onRemove={() => lines.remove(c)} />)}
      {lines.editing === n && <EditingBox lines={lines} />}
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

/** The lines the selection covers inside `box`, and its text, while there is one. */
function useLineSelection(box: React.RefObject<HTMLElement | null>): { from: number; to: number; text: string } | undefined {
  const [range, setRange] = useState<{ from: number; to: number; text: string }>();
  useEffect(() => {
    const lineOf = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return Number(element?.closest('[data-line]')?.getAttribute('data-line')) || undefined;
    };
    const onChange = () => {
      const selection = window.getSelection();
      const el = box.current;
      const text = selection?.toString() ?? '';
      if (!selection || selection.isCollapsed || !text.trim() || !el || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) {
        setRange(undefined);
        return;
      }
      const a = lineOf(selection.anchorNode);
      const b = lineOf(selection.focusNode);
      if (!a || !b) return setRange(undefined);
      setRange({ from: Math.min(a, b), to: Math.max(a, b), text });
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [box]);
  return range;
}

/**
 * Where Changes and files puts a file's selection bar: a row of its own under what scrolls, so
 * the file never scrolls under it; `safe`: the lowest row of the view, clear of the home indicator
 * and level with the view's other lowest rows (Send now, and beside the conversation the message
 * boxes): 8px above the edge at least, on a phone and on a computer. A viewer with none keeps the
 * bar at the foot of the file as it scrolls.
 */
export type SelectionFootAt = { at: HTMLElement; safe?: boolean };
export const SelectionFoot = createContext<SelectionFootAt | undefined>(undefined);

/** Under a selection of lines: quote them into the message as `path:7-8` and the lines, or copy the text. */
function SelectionBar({ from, to, onQuote, text, place }: { from: number; to: number; onQuote: () => void; text: string; place: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex items-center gap-1 border-t border-line bg-bg text-[13px] ${place}`}>
      <span className="min-w-0 flex-1 truncate text-muted">{to > from ? `Lines ${from}–${to}` : `Line ${from}`}</span>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onQuote} className="flex h-9 items-center gap-1.5 rounded-full px-3 hover:bg-hover">
        <Quote className="size-3.5" /> Quote
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })}
        className="flex h-9 items-center gap-1.5 rounded-full px-3 hover:bg-hover"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy
      </button>
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
  // What is typed follows a tap on another line, so a missed line costs nothing.
  const [editing, setEditing] = useState<number>();
  const note = useRef('');
  const [showHint] = useState(() => !tipSeen('line-comments'));
  const sendAll = useSendComments();
  const foot = useContext(SelectionFoot);
  const box = useRef<HTMLDivElement>(null);
  const selection = useLineSelection(box);
  const pick = useLinePick((n: number) => setEditing(n));
  const latest = useRef({ chat, path, texts, editing, sendAll });
  latest.current = { chat, path, texts, editing, sendAll };

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
      if (texts[c.line - 1] === c.code) at.set(c.line, [...(at.get(c.line) ?? []), c]);
      else gone.push(c);
    }
    return { onLine: at, outdated: gone };
  }, [mine, texts]);
  const lines = useMemo<Lines>(() => ({
    path,
    texts,
    digits: String(texts.length).length,
    wrap,
    ...(line ? { target: line } : {}),
    comments: onLine,
    ...(editing ? { editing } : {}),
    note,
    pick,
    save: (typed, now) => {
      const { chat: owner, path: file, texts: text, editing: at, sendAll: send } = latest.current;
      if (!at || !typed.trim()) return;
      setComments(owner, [...commentsOf(owner), { id: newId(), path: file, kind: 'same', line: at, code: text[at - 1] ?? '', note: typed.trim() }]);
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
  }), [path, texts, wrap, line, onLine, editing]);
  const language = LANGUAGE[ext];
  const highlight = text !== undefined && language && text.length <= HIGHLIGHT_MAX.chars && texts.length <= HIGHLIGHT_MAX.lines;

  const quote = () => {
    if (!selection) return;
    onAddToMessage(quoteLines(path, selection.from, selection.to, texts.slice(selection.from - 1, selection.to)), 'quote');
    window.getSelection()?.removeAllRanges();
  };
  // Copy takes the lines themselves: a comment shown between them is not part of the file.
  const bar = selection && ((place: string) => (
    <SelectionBar from={selection.from} to={selection.to} text={selection.from === selection.to ? selection.text : texts.slice(selection.from - 1, selection.to).join('\n')} onQuote={quote} place={place} />
  ));

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
        <button type="button" onClick={() => onAddToMessage(`@${path} `)} className={tool}>
          <AtSign className="size-3.5" /> Mention
        </button>
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
            <p className="px-2 pb-1.5 text-[12px] text-faint"><span className="pointer-fine:hidden">Tap</span><span className="hidden pointer-fine:inline">Click</span> a line to comment on it, or select lines to quote them</p>
          )}
          {outdated.length > 0 && (
            <div className="mb-1.5 overflow-hidden rounded-lg border border-line">
              {outdated.map((c) => <CommentNote key={c.id} comment={c} outdated onRemove={() => lines.remove(c)} />)}
            </div>
          )}
          <LinesContext.Provider value={lines}>
            <div
              ref={box}
              role="group"
              tabIndex={-1}
              aria-label={`The text of ${path}`}
              className={`rounded-lg border border-line font-mono text-[12px] leading-[1.6] [tab-size:4] ${wrap ? 'overflow-hidden' : 'overflow-x-auto'}`}
            >
              {highlight ? <Highlighted text={text} language={language} /> : texts.map((_, i) => <LineRow key={i} n={i + 1} />)}
            </div>
          </LinesContext.Provider>
          {bar && (foot ? createPortal(bar(`py-1.5 pr-2 pl-4 ${foot.safe ? 'pb-safe' : ''}`), foot.at) : bar('sticky bottom-0 z-10 -mx-1 px-3 py-1.5'))}
        </>
      )}
      {data?.truncated && <div className="pt-2 text-center text-[12px] text-faint">Only the first 512 KB is shown</div>}
    </div>
  );
}


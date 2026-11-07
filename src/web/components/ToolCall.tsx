import { CheckCircle2, ChevronRight, Circle, CircleDot, Download, Loader2, MoreHorizontal, TriangleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { revealHidden } from '../../shared/hidden';
import type { ChatMessage, DeliveredFile } from '../../shared/protocol';
import { entries, PATH_ACTIONS, STEP_ACTIONS, type StepTarget } from '../lib/actions';
import { announce } from '../lib/announce';
import { api, ApiError, type SentState } from '../lib/api';
import { addWaiting } from '../lib/drafts';
import { hasKeyboard } from '../lib/keyboard';
import { type Press, useLongPress } from '../lib/press';
import { quoteItem, TOO_MANY_REPLIES } from '../lib/quote';
import { RunInTerminal } from '../lib/terminals';
import { duration, formatBytes } from '../lib/format';
import { useFileLink, usePathLinks } from '../lib/path-links';
import { useSessionId } from '../lib/session-context';
import { STATIC_DEMO } from '../lib/static-demo';
import { useSessionView } from '../lib/store';
import { describeTool, todosOf, type ToolSummary } from '../lib/tools';
import { answersOf, buildItems, cleanOutput, type Outcome, outcomeOf, resultImages, resultText, type ToolCall } from '../lib/turns';
import { Diff, diffStats } from './Diff';
import { openImage } from './Lightbox';
import { PreviewCard } from './Preview';
import { loadsInPlace, Markdown } from './Markdown';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { STEP_LINK } from './PathLink';
import { usePathTarget } from './PathMenu';
import { QuoteTargetContext, SwipeQuote } from './Quotes';
import { WorkflowCard } from './WorkflowCard';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** What you wrote when you turned something down, shown where it happened. */
function Note({ text }: { text: string }) {
  return <div className="border-l-2 border-line pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted">{text}</div>;
}

type Edit = { before: string; after: string };

/** The edits a file tool made, as before/after pairs. */
function editsOf(call: ToolCall): Edit[] {
  const input = call.input;
  if (call.name === 'Edit') return [{ before: str(input.old_string), after: str(input.new_string) }];
  if (call.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Array<Record<string, unknown>>).map((e) => ({ before: str(e.old_string), after: str(e.new_string) }));
  }
  if (call.name === 'Write') return [{ before: '', after: str(input.content) }];
  return [];
}

function Output({ text: raw, failed }: { text: string; failed?: boolean }) {
  const [all, setAll] = useState(false);
  const text = useMemo(() => cleanOutput(raw), [raw]);
  if (!text.trim()) return <div className="text-[12px] text-faint">No output</div>;
  const long = text.length > 1200 || text.split('\n').length > 14;
  return (
    <div>
      <pre
        className={`overflow-x-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words ${failed ? 'text-danger' : 'text-muted'} ${long && !all ? 'max-h-56 overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_80%,transparent)]' : ''}`}
      >
        {text}
      </pre>
      {long && (
        <button type="button" aria-expanded={all} className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function Images({ call }: { call: ToolCall }) {
  const images = resultImages(call.result);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, i) => {
        const source = image.source;
        const src = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
        if (image.omitted || !loadsInPlace(src)) {
          return <div key={i} className="rounded-md bg-chip px-2 py-1 text-[11px] text-faint">Image not shown</div>;
        }
        return (
          <button key={i} type="button" aria-label="Open image" onClick={() => openImage(src)}>
            <img alt="" loading="lazy" decoding="async" className="max-h-64 max-w-full rounded-lg border border-line" src={src} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * How a file Claude sent shows, by its type, as in Claude Desktop: a picture as itself, a video or a
 * sound in a player, a page or an SVG as a still preview, text to read, a PDF in the browser's own
 * viewer, anything else as a file to save.
 */
export type SentKind = 'picture' | 'video' | 'audio' | 'page' | 'text' | 'pdf' | 'file';

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
/** The videos and sounds Claude Desktop plays in place, by their names. */
const VIDEO = /\.(mp4|webm|mov)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|flac|opus|ogg|oga)$/i;
const PAGE = /\.(html?|svg)$/i;
const TEXT = /\.(md|markdown|txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|sh|bash|zsh|fish|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|sql|r|js|jsx|mjs|cjs|ts|tsx|css|scss|vue|svelte|diff|patch)$/i;

export function sentKind(file: DeliveredFile): SentKind {
  if (PICTURE.test(file.path)) return 'picture';
  // Unless Claude Code took one for a picture, as Claude Desktop tells them.
  if (!file.image && VIDEO.test(file.path)) return 'video';
  if (!file.image && AUDIO.test(file.path)) return 'audio';
  if (PAGE.test(file.path)) return 'page';
  if (/\.pdf$/i.test(file.path)) return 'pdf';
  if (TEXT.test(file.path) || /^text\//.test(file.type ?? '') || file.type === 'application/json') return 'text';
  return 'file';
}

/** The files a call handed over: what Claude Code delivered with SendUserFile, the page an Artifact call published. */
export function sentFilesOf(call: ToolCall): DeliveredFile[] {
  if (!call.result || call.result.is_error) return [];
  if (call.name === 'SendUserFile') return call.result.delivered?.files ?? [];
  if (call.name === 'Artifact' && str(call.input.file_path) && (!call.input.action || call.input.action === 'publish')) return [{ path: str(call.input.file_path) }];
  return [];
}

/**
 * A file's name as it shows, with any character that hides or turns text around shown as such
 * (⟨U+202E⟩): sent without asking, a file's card may be the only place its name is seen, and one
 * such character makes a script read as a picture.
 */
const fileName = (file: string) => revealHidden(file.split('/').pop() || file).text;
const hidesCharacters = (file: string) => revealHidden(file.split('/').pop() || file).hidden;
const CARD = 'rounded-xl border border-line bg-panel';
/** A card of one line, as Claude Desktop's: as wide as what it says, never wider than the column. */
const LINE = 'flex min-h-10 min-w-0 items-center gap-2 pr-1 pl-2.5 text-[13px] pointer-coarse:min-h-11';
/** Beside pictures, a file is a square tile of a thumbnail's size, as in Claude Desktop. */
const TILE = 'size-[120px] shrink-0';
const TILE_FACE = `${CARD} flex size-full flex-col items-start justify-between gap-1.5 p-2.5 text-left`;

/**
 * How the files of one call lie, as Claude Desktop lays them out: videos and sounds first, each in a
 * player of its own; pictures that come alone, or with videos only, at their own size, side by side
 * (`natural`), a video too; beside other files (or a sound), pictures as small squares, a video
 * smaller, and the other files as tiles of a square's size (`square`); other files alone as cards of
 * a line.
 */
type Layout = { natural: boolean; square: boolean };

const playable = (kind: SentKind) => kind === 'video' || kind === 'audio';

/** A file's type, as Claude Desktop marks a card: its extension, small. */
function Badge({ name }: { name: string }) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '';
  return <span aria-hidden className="grid h-[18px] min-w-7 shrink-0 place-items-center rounded border border-line px-1 text-[9.5px] font-semibold tracking-wide text-faint uppercase">{ext || 'file'}</span>;
}

/** The name, and the size Claude Code found when it sent it; `muted` for a file that cannot be had. */
function Label({ name, size, muted = false }: { name: string; size?: number; muted?: boolean }) {
  return (
    <>
      <span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${muted ? 'text-faint' : 'text-fg/90'}`}>{name}</span>
      {size !== undefined && <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{formatBytes(size)}</span>}
    </>
  );
}

/** A tile's words: its name over two lines at most, its size, and why it cannot be had (`why`). */
function TileLabel({ name, size, why }: { name: string; size?: number; why?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 self-stretch">
      <span className={`line-clamp-2 font-mono text-[12px] leading-snug break-all ${why ? 'text-faint' : 'text-fg/90'}`}>{name}</span>
      {size !== undefined && <span className="text-[11px] leading-tight text-faint tabular-nums">{formatBytes(size)}</span>}
      {why && <span className="text-[11px] leading-tight text-faint">{why}</span>}
    </span>
  );
}

/** Over a picture or a tile, in its corner: shown on a touch screen, else when pointed at or focused. */
const SHOWN_AT_HAND = 'rounded-lg bg-bg/85 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100';
const CORNER = `absolute top-1.5 right-1.5 ${SHOWN_AT_HAND}`;
/** A picture shown at its own size this small would be hidden by the button in its corner: the button goes beside it. */
const SMALL_PICTURE = { width: 120, height: 96 };

/** Why a file Claude sent cannot be had, as the server says it too (app.ts). */
const GONE = 'No longer on this computer';
const TOO_LARGE = 'Larger than Pelican serves (200 MB)';

/** A file Claude sent that cannot be had: named and sized, muted, with why, and nothing to tap. */
function Unavailable({ name, size, why, square }: { name: string; size?: number; why: string; square: boolean }) {
  if (square) {
    return (
      <div className={TILE}>
        <div className={TILE_FACE}>
          <Badge name={name} />
          <TileLabel name={name} size={size} why={why} />
        </div>
      </div>
    );
  }
  return (
    <div className={`${CARD} w-fit max-w-full`}>
      <div className={`${LINE} pr-3`}>
        <Badge name={name} />
        <Label name={name} size={size} muted />
      </div>
      <div className="-mt-1.5 px-3 pb-2 text-[12px] text-faint">{why}</div>
    </div>
  );
}

const ICON = 'grid size-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg pointer-coarse:size-10';

/** Saves the file, as it is on the computer now. */
function Save({ sessionId, file, href }: { sessionId: string; file: string; href?: string }) {
  const name = fileName(file);
  return (
    <a href={href ?? api.sentUrl(sessionId, file, true)} download={name} aria-label={`Download ${name}`} title="Download" className={ICON}>
      <Download className="size-3.5" />
    </a>
  );
}

/** Folded, a text file draws no more than this: a long one would otherwise be laid out whole, unseen. */
const FOLDED_CHARS = 20_000;

/** A text file Claude sent, to read: Markdown as it reads, anything else as it is; one taller than its box folded. */
function TextBody({ text, markdown, truncated }: { text: string; markdown: boolean; truncated?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(text.length > FOLDED_CHARS);
  const shown = all ? text : text.slice(0, FOLDED_CHARS);
  // Whether it is taller than its box, at the width it is read at.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || all) return undefined;
    const check = () => setLong(text.length > FOLDED_CHARS || element.scrollHeight > element.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [all, text]);
  if (!text.trim()) return <div className="px-3 py-2 text-[12px] text-faint">Empty file</div>;
  return (
    <div className="px-3 py-2">
      <div ref={box} className={all ? '' : `max-h-72 overflow-hidden ${long ? '[mask-image:linear-gradient(to_bottom,black_75%,transparent)]' : ''}`}>
        {markdown ? <Markdown text={shown} className="text-[14px]" /> : <pre className="font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-fg/90">{shown}</pre>}
      </div>
      {long && (
        <button type="button" aria-expanded={all} className="relative mt-1 text-[12px] text-faint after:absolute after:-inset-x-1.5 after:-inset-y-3 hover:text-fg" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
      {truncated && all && <div className="mt-1 text-[12px] text-faint">Only the first 512 KB is shown</div>}
    </div>
  );
}

/**
 * A file Claude sent, as its type shows: in place (`open`), or as a card that opens it, laid out as
 * its call's files lie. `state`: whether it is still there to have, as its call's files were found.
 */
function SentFile({ sessionId, file, open: startOpen, layout, state }: { sessionId: string; file: DeliveredFile; open: boolean; layout: Layout; state?: SentState }) {
  const kind = sentKind(file);
  const name = fileName(file.path);
  const [open, setOpen] = useState(startOpen);
  const [broken, setBroken] = useState(false);
  const [small, setSmall] = useState(false);
  // The site's demo has no computer behind it: its picture comes as data, as text does.
  const needsData = open && (kind === 'page' || kind === 'text' || (kind === 'picture' && STATIC_DEMO));
  const { data, error, isLoading } = useQuery({
    queryKey: ['sent', sessionId, file.path],
    queryFn: () => api.sent(sessionId, file.path),
    // Past what Pelican serves, a text file still shows its start; nothing else of it comes.
    enabled: needsData && state !== 'gone' && (state !== 'large' || kind === 'text'),
    staleTime: 60_000,
  });
  const gone = state === 'gone' || (error instanceof ApiError && error.status === 410);
  if (gone || (state === 'large' && kind !== 'text')) return <Unavailable name={name} size={file.size} why={gone ? GONE : TOO_LARGE} square={layout.square} />;
  const failure = error ? <div className="px-3 pb-2 text-[12px] text-danger">{(error as Error).message}</div> : null;

  // On the site, a picture too large to come as data has nothing to show it from.
  const noData = kind === 'picture' && STATIC_DEMO && Boolean(data) && !data?.image;
  if (kind === 'picture' && open && !broken && !noData && !error) {
    const src = STATIC_DEMO ? data?.image : api.sentUrl(sessionId, file.path);
    if (!src) return <div className={`${CARD} ${LINE} w-fit max-w-full`}><Badge name={name} /><Label name={name} size={file.size} /><Loader2 className="mr-2 size-3.5 animate-spin text-faint" /></div>;
    // Alone, a picture at its own size, up to 360 by 480; beside other files, a square of 120. One
    // at its own size that is small has its button beside it, which would cover it in its corner.
    const beside = layout.natural && small;
    return (
      <div className={`group relative ${layout.natural ? 'w-fit max-w-[min(100%,480px)]' : TILE} ${beside ? 'flex items-start gap-1.5' : ''}`}>
        <button type="button" aria-label={`Open ${name}`} onClick={() => openImage(src)} className={layout.natural ? 'block max-w-full' : 'block size-full'}>
          <img
            src={src} alt={name} title={name} loading="lazy" decoding="async" onError={() => setBroken(true)}
            onLoad={(event) => setSmall(event.currentTarget.clientWidth < SMALL_PICTURE.width || event.currentTarget.clientHeight < SMALL_PICTURE.height)}
            className={`rounded-xl border border-line bg-panel ${layout.natural ? 'block max-h-[360px] max-w-full' : 'size-full object-contain'}`}
          />
        </button>
        <div className={beside ? `shrink-0 ${SHOWN_AT_HAND}` : CORNER}>
          <Save sessionId={sessionId} file={file.path} {...(STATIC_DEMO ? { href: src } : {})} />
        </div>
      </div>
    );
  }
  if (playable(kind) && open && !broken) {
    const src = api.sentUrl(sessionId, file.path);
    if (kind === 'audio') {
      // A sound, under its name, as Claude Desktop plays one.
      return (
        <div className="basis-full">
          <div className={`${CARD} w-full max-w-[360px]`}>
            <div className={LINE}>
              <Badge name={name} />
              <Label name={name} size={file.size} />
              <Save sessionId={sessionId} file={file.path} />
            </div>
            <div className="px-2 pb-2">
              <audio controls preload="metadata" src={src} title={name} aria-label={name} onError={() => setBroken(true)} className="block w-full" />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="basis-full">
        <div className={`group relative w-fit ${layout.natural ? 'max-w-[min(100%,480px)]' : 'max-w-[min(100%,320px)]'}`}>
          <video
            controls preload="metadata" playsInline src={src} title={name} aria-label={name} onError={() => setBroken(true)}
            className={`block max-w-full rounded-xl bg-black ${layout.natural ? 'max-h-[360px]' : 'max-h-[240px]'}`}
          />
          <div className={CORNER}><Save sessionId={sessionId} file={file.path} /></div>
        </div>
      </div>
    );
  }
  if (kind === 'page' && open && data?.text !== undefined && !data.truncated) {
    return (
      <div className="basis-full">
        <PreviewCard source={{ kind: /\.svg$/i.test(name) ? 'svg' : 'html', code: data.text, title: name, file: true }} label={name} download={{ href: api.sentUrl(sessionId, file.path, true), name }} />
      </div>
    );
  }
  if (kind === 'pdf' || kind === 'file') {
    // A PDF opens in a tab of its own, in the browser's viewer; anything else is saved.
    const pdf = kind === 'pdf';
    const link = {
      href: api.sentUrl(sessionId, file.path, !pdf),
      ...(pdf ? { target: '_blank', rel: 'noopener' } : { download: name }),
      'aria-label': pdf ? `Open ${name}` : `Download ${name}`,
    };
    if (layout.square) {
      return (
        <div className={`group relative ${TILE}`}>
          <a {...link} className={`${TILE_FACE} hover:bg-hover`}>
            <Badge name={name} />
            <TileLabel name={name} size={file.size} />
          </a>
          {pdf ? <div className={CORNER}><Save sessionId={sessionId} file={file.path} /></div> : <Download aria-hidden className="absolute top-3 right-3 size-3.5 text-faint" />}
        </div>
      );
    }
    return (
      <div className={`${CARD} ${LINE} w-fit max-w-full`}>
        <a {...link} className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <Badge name={name} />
          <Label name={name} size={file.size} />
          {!pdf && <Download className="mr-2.5 size-3.5 shrink-0 text-faint" />}
        </a>
        {pdf && <Save sessionId={sessionId} file={file.path} />}
      </div>
    );
  }
  // Text, and a picture, a video, a sound or a page while it is closed (or cannot be shown): a card
  // that opens it.
  const unshowable = broken || noData || (kind === 'page' && data?.truncated);
  const toggle = { type: 'button' as const, 'aria-label': name, 'aria-expanded': open && !unshowable, disabled: Boolean(unshowable), onClick: () => setOpen((v) => !v) };
  // A tile while it is closed and has nothing to say; open, it takes the width what it shows needs.
  if (layout.square && !open && !unshowable && !failure) {
    return (
      <div className={`group relative ${TILE}`}>
        <button {...toggle} className={`${TILE_FACE} hover:bg-hover`}>
          <Badge name={name} />
          <TileLabel name={name} size={file.size} />
        </button>
        <div className={CORNER}><Save sessionId={sessionId} file={file.path} /></div>
      </div>
    );
  }
  return (
    <div className={`${CARD} overflow-hidden ${open && kind === 'text' ? 'basis-full' : 'w-fit max-w-full'}`}>
      <div className={LINE}>
        <button {...toggle} className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left">
          <Badge name={name} />
          <Label name={name} size={file.size} />
          {!unshowable && (isLoading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" /> : <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />)}
        </button>
        {state !== 'large' && <Save sessionId={sessionId} file={file.path} />}
      </div>
      {open && failure}
      {(broken || noData) && <div className="px-3 pb-2 text-[12px] text-faint">{kind === 'video' ? 'This video can’t be played here' : kind === 'audio' ? 'This audio can’t be played here' : 'This picture can’t be shown here'}</div>}
      {kind === 'page' && data?.truncated && <div className="px-3 pb-2 text-[12px] text-faint">Too large to preview here</div>}
      {open && kind === 'text' && data && (
        <div className="border-t border-line bg-bg">
          {data.text !== undefined ? <TextBody text={data.text} markdown={/\.(md|markdown)$/i.test(name)} truncated={data.truncated} /> : <div className="px-3 py-2 text-[12px] text-faint">A binary file; nothing to show here</div>}
        </div>
      )}
      {state === 'large' && <div className="px-3 pb-2 text-[12px] text-faint">{TOO_LARGE}, so it can’t be downloaded here</div>}
    </div>
  );
}

/** Files Claude handed over (SendUserFile, Artifact), shown the way Claude Desktop shows them. */
function SentFiles({ call }: { call: ToolCall }) {
  const sessionId = useSessionId();
  const files = sentFilesOf(call);
  const delivered = call.result?.delivered;
  const caption = delivered?.caption ?? (str(call.input.caption) || str(call.input.description));
  const link = resultText(call.result).match(/https:\/\/claude\.ai\/[^\s)"']+/)?.[0];
  // In place, unless Claude meant them as files to save.
  const open = call.name === 'Artifact' || delivered?.display !== 'attach';
  const missed = delivered?.missed ?? 0;
  const kinds = files.map(sentKind);
  const others = kinds.filter((kind) => !playable(kind));
  const pictures = others.filter((kind) => kind === 'picture').length;
  const layout: Layout = { natural: pictures === others.length && !kinds.includes('audio'), square: pictures > 0 && pictures < others.length };
  // Players first, then the rest in the order Claude sent them.
  const order = files.map((file, i) => ({ file, i })).sort((a, b) => Number(playable(kinds[b.i]!)) - Number(playable(kinds[a.i]!)));
  const hidden = files.some((file) => hidesCharacters(file.path));
  // Whether each is still there to have, known before any of them shows: older sessions are full of
  // files that have since moved. Should nobody be able to say, they show as they would.
  const paths = [...new Set(files.map((file) => file.path))].slice(0, 50);
  const states = useQuery({
    // Per call: a file Claude sends again under the same name is asked about afresh.
    queryKey: ['sent-state', sessionId, call.id, ...paths],
    queryFn: () => api.sentStates(sessionId!, paths),
    enabled: Boolean(sessionId),
    staleTime: 60_000,
    retry: false,
  });
  const checked = states.data !== undefined || states.isError;
  if (!sessionId) return null;
  return (
    // What shows in place at full width takes a line of its own; the rest sit side by side and wrap.
    <div role="group" aria-label={files.length === 1 ? 'Sent file' : `Sent ${files.length} files`} aria-busy={!checked} className="my-1.5 flex flex-wrap items-start gap-2">
      {/* Claude's words with the files, as Claude Desktop shows them: as a reply reads, Markdown and all. */}
      {caption && <Markdown text={caption} className="basis-full" />}
      {checked && order.map(({ file, i }) => <SentFile key={`${i}:${file.path}`} sessionId={sessionId} file={file} open={open} layout={layout} state={states.data?.get(file.path)} />)}
      {checked && hidden && (
        <div className="flex basis-full items-start gap-1.5 text-[12.5px] leading-snug text-danger">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          This contains invisible or direction-changing characters, shown as ⟨U+…⟩. It may not do what it seems to.
        </div>
      )}
      {missed > 0 && <div className="basis-full text-[12px] text-faint">{missed === 1 ? '1 more file could not be sent' : `${missed} more files could not be sent`}</div>}
      {link && <a href={link} target="_blank" rel="noreferrer" className="inline-flex basis-full text-[12.5px] text-faint underline decoration-faint underline-offset-2 hover:text-fg">Open the published page</a>}
    </div>
  );
}

/**
 * What a subagent did, from its own transcript: its tool calls, opened on request. A page at a
 * time, the newest first, as a workflow agent's: a long one is tens of megabytes. A page with no
 * step in it (a long answer at the end, a step too large to share a page) is read past, at first
 * and at each Show earlier, so the count is always of steps shown: its last ones, all of them, or
 * none, once its start says so.
 */
function AgentSteps({ agentId, cwd }: { agentId: string; cwd?: string }) {
  const sessionId = useSessionId();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['subagent', sessionId, agentId],
    queryFn: () => api.subagent(sessionId!, agentId),
    enabled: open && Boolean(sessionId),
    staleTime: 60_000,
  });
  // Earlier pages, asked for one at a time, up to where the newest begins; let go if it was read again.
  const [earlier, setEarlier] = useState<{ messages: ChatMessage[]; offset: number; joins: number }>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<Error>();
  // How many steps to show at least: one at first, then one more than shown at each Show earlier.
  const [wanted, setWanted] = useState(1);
  const asking = useRef(false);
  const before = earlier && data && earlier.joins === data.offset ? earlier : undefined;
  const offset = before?.offset ?? data?.offset ?? 0;
  const older = async () => {
    if (asking.current || !data || offset === 0) return;
    asking.current = true;
    setLoading(true);
    try {
      const page = await api.subagent(sessionId!, agentId, offset);
      setEarlier((had) => ({ messages: [...page.messages, ...(had && had.joins === data.offset ? had.messages : [])], offset: page.offset, joins: data.offset }));
    } catch (err) {
      setFailed(err as Error);
    } finally {
      asking.current = false;
      setLoading(false);
    }
  };
  const messages = useMemo(() => [...(before?.messages ?? []), ...(data?.messages ?? [])], [before, data]);
  const steps = useMemo(() => buildItems(messages).flatMap((item) => (item.kind === 'assistant' ? item.parts : [])).filter((part) => part.kind === 'tool'), [messages]);
  // Fewer steps than wanted, and more before them: the page before. Each ends nearer the start.
  const short = open && Boolean(data) && steps.length < wanted && offset > 0 && !failed;
  useEffect(() => {
    if (short && !loading) void older();
  }, [short, loading, offset]);
  if (!sessionId) return null;
  // Nothing to count yet, with more to read: no number until there is one.
  const counted = open && data && !(steps.length === 0 && offset > 0);
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px]">
      <div className="flex min-h-7 items-center gap-3">
        <button type="button" className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-faint hover:text-fg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          {counted ? `${offset > 0 ? 'Last ' : ''}${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : 'Steps it took'}
          {open && (isLoading || loading) && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
        </button>
        {open && offset > 0 && (steps.length > 0 || failed) && (
          <button
            type="button"
            onClick={() => {
              setFailed(undefined);
              setWanted(steps.length + 1);
            }}
            className="relative shrink-0 text-[12px] text-faint after:absolute after:-inset-x-1.5 after:-inset-y-3 hover:text-fg"
          >
            Show earlier
          </button>
        )}
      </div>
      {open && (error || failed) && <div className="py-1 text-[12px] text-danger">{((error ?? failed) as Error).message}</div>}
      {open && data && steps.length === 0 && offset === 0 && <div className="py-1 text-[12px] text-faint">No steps were recorded.</div>}
      {open && steps.map((part) => (part.kind === 'tool' ? <ToolCallView key={part.key} call={part.call} cwd={cwd} running={false} /> : null))}
    </div>
  );
}

/** What a running subagent is doing, as Claude Code reports it: its summary or last tool, its steps, its time. */
function AgentProgress({ toolUseId }: { toolUseId: string }) {
  const report = useSessionView(useSessionId()).run?.progress?.[toolUseId];
  if (!report) return null;
  const steps = report.toolUses ? `${report.toolUses} ${report.toolUses === 1 ? 'step' : 'steps'}` : undefined;
  const parts = [report.summary ?? report.lastTool, steps, report.durationMs ? duration(report.durationMs) : undefined].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="-mt-1 mb-1 ml-5.5 truncate text-[12px] text-faint">{parts.join(' · ')}</div>;
}

/** A page or a picture Claude wrote, worth seeing rendered rather than as code. */
const PREVIEWABLE = /\.(html?|svg)$/i;

function Detail({ call, cwd, outcome }: { call: ToolCall; cwd?: string; outcome: Outcome }) {
  // A call that never ran (refused) or was cut short gave back only a note to Claude, which the
  // row already shows: what is left to see is what it would have done.
  const ran = outcome.kind === 'done' || outcome.kind === 'failed';
  const failed = outcome.kind === 'failed';
  const output = ran ? resultText(call.result) : '';
  const edits = editsOf(call);
  const file = str(call.input.file_path);
  if (call.name === 'Write' && PREVIEWABLE.test(file) && (outcome.kind === 'done' || outcome.kind === 'pending')) {
    const name = file.split('/').pop() ?? file;
    return <PreviewCard source={{ kind: /\.svg$/i.test(file) ? 'svg' : 'html', code: str(call.input.content), title: name, file: true }} label={name} />;
  }
  if (edits.length > 0 && !failed) {
    return (
      <div className="space-y-2">
        {edits.map((edit, i) => <Diff key={i} before={edit.before} after={edit.after} />)}
      </div>
    );
  }
  switch (call.name) {
    case 'TodoWrite':
      return <TodoList input={call.input} />;
    case 'Bash':
    case 'PowerShell':
      return (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words">
            <span className="select-none text-faint">$ </span>
            {str(call.input.command)}
          </pre>
          {ran && <Output text={output} failed={failed} />}
        </div>
      );
    case 'Agent':
    case 'Task': {
      const agentId = output.match(/agentId:\s*([\w-]+)/)?.[1];
      return (
        <div className="space-y-2">
          {str(call.input.prompt) && (
            <details className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
              <summary className="cursor-pointer text-faint">Instructions</summary>
              <Markdown text={str(call.input.prompt)} className="mt-2 text-[13px]" />
            </details>
          )}
          {agentId && <AgentSteps agentId={agentId} cwd={cwd} />}
          {ran && <Markdown text={output.replace(/\n*agentId:[\s\S]*$/, '')} className="text-[14px]" />}
        </div>
      );
    }
    default:
      return (
        <div className="space-y-2">
          {ran ? (
            <>
              <Output text={output} failed={failed} />
              <Images call={call} />
            </>
          ) : (
            <Output text={JSON.stringify(call.input, null, 2)} />
          )}
        </div>
      );
  }
}

export function TodoList({ input }: { input: Record<string, unknown> }) {
  const todos = todosOf(input);
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="mb-1.5 text-[12px] text-faint">
        Tasks · {done}/{todos.length}
      </div>
      <ul className="space-y-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug">
            {todo.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-live" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 size-4 shrink-0 text-run" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-faint" />
            )}
            <span className={todo.status === 'completed' ? 'text-faint line-through' : ''}>
              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Claude's questions with what you answered: the answers live in the text Claude Code gave back, not in the call. */
function QuestionsAnswered({ call }: { call: ToolCall }) {
  const questions = Array.isArray(call.input.questions) ? (call.input.questions as Array<Record<string, unknown>>) : [];
  const outcome = outcomeOf(call);
  const output = resultText(call.result);
  const answers = outcome.kind === 'done' ? answersOf(questions.map((q) => str(q.question)), output) : {};
  // Words typed in place of picking, for all the questions at once.
  const response = outcome.kind === 'done' ? output.match(/^The user responded: ([\s\S]*)$/)?.[1] : undefined;
  const answered = Boolean(response) || Object.values(answers).some((a) => a.answer || a.notes);
  return (
    <div className="my-1.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13.5px]">
      {questions.map((q, i) => {
        const answer = answers[str(q.question)];
        return (
          <div key={i} className={i > 0 ? 'mt-2' : ''}>
            <div className="text-muted">{str(q.question)}</div>
            {answer?.answer && <div className="mt-0.5 font-medium">{answer.answer}</div>}
            {answer?.notes && <div className="mt-0.5 whitespace-pre-wrap text-muted">{answer.notes}</div>}
          </div>
        );
      })}
      {response && <div className="mt-2 font-medium whitespace-pre-wrap">{response}</div>}
      {questions.length === 0 && output && <div className="text-muted">{output}</div>}
      {questions.length > 0 && !answered && <div className="mt-2 text-faint">{outcome.kind === 'stopped' ? 'Interrupted' : 'Not answered'}</div>}
      {outcome.kind === 'denied' && outcome.note && <div className="mt-1.5"><Note text={outcome.note} /></div>}
    </div>
  );
}

const PLAN_STATUS: Partial<Record<Outcome['kind'], string>> = { done: 'Approved', denied: 'Sent back', stopped: 'Interrupted' };

function PlanCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const plan = str(call.input.plan);
  const outcome = outcomeOf(call);
  const status = PLAN_STATUS[outcome.kind];
  return (
    <div className="my-1.5 rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="mb-1 text-[12px] text-faint">Plan{status ? ` · ${status}` : ''}</div>
      <div className={open ? '' : 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'}>
        <Markdown text={plan} className="text-[14px]" />
      </div>
      <button type="button" aria-expanded={open} className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show the whole plan'}
      </button>
      {outcome.kind === 'denied' && outcome.note && <div className="mt-2"><Note text={outcome.note} /></div>}
    </div>
  );
}

/** A tool's target: a file name with its folder dimmed, a command in mono, or a plain description. */
export function ToolTarget({ summary }: { summary: ToolSummary }) {
  const target = summary.target ?? '';
  if (summary.path) {
    const cut = target.lastIndexOf('/');
    const name = cut >= 0 ? target.slice(cut + 1) : target;
    const dir = cut > 0 ? target.slice(0, cut) : '';
    return (
      <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
        {/* The folder gives way first; a name longer than the row then ends in an ellipsis, never cut off. */}
        <span className="min-w-0 truncate font-mono text-[12px] text-fg/85">{name}</span>
        {/* Right-to-left so a long folder loses its start, not its end; the marks keep the slashes in place. */}
        {dir && <span className="min-w-0 shrink-[1000] truncate font-mono text-[11px] text-faint" dir="rtl">{`\u200e${dir}\u200e`}</span>}
      </span>
    );
  }
  return <span className={`min-w-0 truncate ${summary.prose ? '' : 'font-mono text-[12px]'}`}>{target}</span>;
}

/** The file a step read or changed, and the line to open it at: where a Read began, where an edit's change is. */
function useStepFile(call: ToolCall) {
  const lines = usePathLinks()?.lines;
  const file = FILE_TOOLS.has(call.name) ? str(call.input.file_path) || str(call.input.notebook_path) : '';
  const offset = typeof call.input.offset === 'number' ? call.input.offset : undefined;
  const line = call.name === 'Read' ? offset : lines?.[call.id];
  return useFileLink(file || undefined, line && line > 0 ? line : undefined);
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** A step's menu, open: where, and the row a finger raised. */
type StepMenuAt = { at: MenuAnchor; lift?: Element; keys?: boolean };

export const ToolCallView = memo(function ToolCallView({ call, cwd, running, defaultOpen = false }: { call: ToolCall; cwd?: string; running: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const summary = describeTool(call.name, call.input, cwd);
  const outcome = outcomeOf(call);
  const fileLink = useStepFile(call);
  // A step's own list: a command's, an agent's, or a file step's path menu (lib/actions).
  const quoteTo = useContext(QuoteTargetContext);
  const runIn = useContext(RunInTerminal);
  const path = usePathTarget(fileLink?.path);
  const [menu, setMenu] = useState<StepMenuAt>();
  const isCommand = call.name === 'Bash' || call.name === 'PowerShell';
  const isAgent = call.name === 'Agent' || call.name === 'Task';
  const commandText = isCommand ? str(call.input.command) : '';
  const stepTarget = (): StepTarget | undefined => {
    if (isAgent) return { kind: 'agent', viewOutput: () => setOpen(true) };
    if (!isCommand || !commandText) return undefined;
    const output = outcome.kind === 'done' || outcome.kind === 'failed' ? cleanOutput(resultText(call.result)).trim() : '';
    const from = { what: 'step' as const, key: call.id };
    return {
      kind: 'command',
      command: commandText,
      ...(output ? { output } : {}),
      ...(runIn ? { runInTerminal: () => runIn(commandText) } : {}),
      ...(quoteTo?.sideChat ? {
        sideChatOpen: quoteTo.sideChat.open,
        sideChat: (passage?: string) => {
          const quoted = quoteItem(passage || commandText, from);
          if (quoted) quoteTo.sideChat?.start(quoted);
        },
      } : {}),
      ...(quoteTo ? {
        quote: (passage: string) => {
          const quoted = quoteItem(passage, from);
          if (!quoted) return;
          announce(addWaiting(quoteTo.chat, quoted) ? 'Quoted in your message' : TOO_MANY_REPLIES);
        },
      } : {}),
    };
  };
  const device = hasKeyboard() ? 'pointer' : 'touch';
  const listFor = () => {
    const step = stepTarget();
    if (step) return entries(STEP_ACTIONS, step, 'menu', device);
    return path ? entries(PATH_ACTIONS, path, 'menu', device) : [];
  };
  const hasMenu = isAgent || (isCommand && Boolean(commandText)) || Boolean(path);
  const press = useLongPress<HTMLDivElement>((p: Press) => {
    setMenu(p.pointerType === 'touch' || p.pointerType === 'pen' ? { at: p.element, lift: p.element } : p.pointerType === 'keyboard' ? { at: p.element, keys: true } : { at: { x: p.x, y: p.y } });
  }, { enabled: hasMenu, nativeMenu: (target) => Boolean(target.closest('a[href]:not([data-path-link]), img')) });
  const stats = useMemo(() => {
    const edits = editsOf(call);
    if (edits.length === 0) return undefined;
    return edits.reduce((acc, e) => {
      const s = diffStats(e.before, e.after);
      return { added: acc.added + s.added, removed: acc.removed + s.removed };
    }, { added: 0, removed: 0 });
  }, [call]);

  if (call.name === 'TodoWrite' && !call.sameTasks) return <div className="my-1.5"><TodoList input={call.input} /></div>;
  // A workflow, as Claude Code shows one: its phases and agents, never its script's first line.
  if (call.name === 'Workflow') return <WorkflowCard call={call} {...(cwd ? { cwd } : {})} running={running} defaultOpen={defaultOpen} />;
  // Files and visuals only from calls that ran: a call Claude only wrote (one no app answered, or
  // one that failed) shows as a step, with its input as text.
  const ran = Boolean(call.result && !call.result.is_error);
  if (sentFilesOf(call).length > 0) return <SentFiles call={call} />;
  // Claude Desktop's visuals (diagrams, charts, small tools): drawn in place, as Desktop shows them.
  if (ran && /(^|__)show_widget$/.test(call.name) && str(call.input.widget_code)) {
    const code = str(call.input.widget_code);
    return (
      <div className="my-1">
        <PreviewCard source={{ kind: /^\s*<svg/i.test(code) ? 'svg' : 'html', code, widget: true, ...(str(call.input.title) ? { title: str(call.input.title) } : {}) }} label={str(call.input.title).replace(/_/g, ' ') || 'Visual'} />
      </div>
    );
  }
  if (call.name === 'AskUserQuestion' && call.result) return <QuestionsAnswered call={call} />;
  // While it waits for approval, the approval card shows the plan; the transcript only notes it.
  if (call.name === 'ExitPlanMode' && str(call.input.plan) && call.result) return <PlanCard call={call} />;

  const Icon = summary.icon;
  // Claude Code ran it and delivered none of its files (one now leads elsewhere): no better than failing.
  const undelivered = ran && call.result?.delivered?.files.length === 0;
  const failed = outcome.kind === 'failed' || undelivered;
  // A tool with words of its own for a step at work and one that failed says them, as Claude Desktop does.
  const verb = outcome.kind === 'pending' && running ? summary.running ?? summary.verb : failed ? summary.failed ?? summary.verb : summary.verb;
  // A refused or interrupted edit changed nothing, whatever it meant to change.
  const changed = stats && (outcome.kind === 'done' || outcome.kind === 'pending') && (stats.added > 0 || stats.removed > 0);
  const row = (target: React.ReactNode) => (
    <>
      <Icon className={`size-3.5 shrink-0 ${failed ? 'text-danger' : ''}`} />
      <span className="shrink-0 text-fg/80">{verb}</span>
      {target}
      {changed && (
        <span className="shrink-0 font-mono text-[11px]">
          {stats.added > 0 && <span className="text-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="ml-1 text-del">−{stats.removed}</span>}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        {outcome.kind === 'pending' && running && <Loader2 className="size-3.5 animate-spin text-faint" />}
        {failed && !summary.failed && <span className="text-[11px] text-danger">failed</span>}
        {outcome.kind === 'denied' && <span className="text-[11px] text-faint">denied</span>}
        {outcome.kind === 'stopped' && <span className="text-[11px] text-faint">interrupted</span>}
        <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </span>
    </>
  );
  // A command's output can be quoted: swiped to the left on a phone, or selected once it is open.
  const command = (call.name === 'Bash' || call.name === 'PowerShell') && outcome.kind !== 'pending';
  const menuNow = menu ? listFor() : [];
  const step = (
    <div
      data-quote-from={call.id}
      data-quote-what="step"
      data-step
      {...(hasMenu ? {
        ...press,
        // Its own list, not the reply's it is in.
        onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => {
          press.onContextMenu(e);
          e.stopPropagation();
        },
      } : {})}
      className={`group/step relative ${hasMenu ? press.className : ''}`}
    >
      {hasMenu && (
        // With a pointer, ⋯ beside the chevron on hover, or reached with the keyboard.
        <button
          type="button"
          aria-label={`More for ${summary.verb}${summary.target ? ` ${summary.target}` : ''}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={(e) => setMenu({ at: e.currentTarget, ...(e.detail === 0 ? { keys: true } : {}) })}
          className={`absolute top-0.5 right-5 z-[2] hidden size-7 place-items-center rounded-md text-faint opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/step:opacity-100 pointer-fine:grid ${menu ? 'opacity-100' : ''}`}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      )}
      {hasMenu && (
        <ActionMenu
          open={Boolean(menu)}
          onClose={() => setMenu(undefined)}
          label={`${summary.verb}${summary.target ? ` ${summary.target}` : ''}`}
          title={<>{summary.verb}{summary.target && <> · <span className={summary.prose ? '' : 'font-mono'}>{summary.target}</span></>}</>}
          entries={menuNow}
          at={menu?.at ?? null}
          focusFirst={Boolean(menu?.keys)}
          {...(menu?.lift ? { lift: menu.lift } : {})}
        />
      )}
      {fileLink ? (
        // The file's name opens it, as a path does in Claude Desktop; the rest of the row still
        // opens the step (its toggle lies under the whole row, the name's link above it). On a
        // touch screen the row is a finger tall and the name takes taps over all of its height.
        <div className="group relative flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-[13px] text-muted hover:text-fg pointer-coarse:min-h-11">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${verb} ${summary.target ?? ''}`.trim()} className="absolute inset-0 rounded-md" />
          {row(
            <a href={fileLink.href} onClick={fileLink.onClick} title={`Open ${fileLink.path}`} className={`relative z-[1] flex min-w-0 ${STEP_LINK} pointer-coarse:self-stretch pointer-coarse:items-center pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1`}>
              <ToolTarget summary={summary} />
            </a>,
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-left text-[13px] text-muted hover:text-fg"
          aria-expanded={open}
        >
          {row(summary.target && <ToolTarget summary={summary} />)}
        </button>
      )}
      {outcome.kind === 'pending' && running && (call.name === 'Agent' || call.name === 'Task') && <AgentProgress toolUseId={call.id} />}
      {outcome.kind === 'denied' && outcome.note && <div className="mb-1.5 ml-5.5"><Note text={outcome.note} /></div>}
      {open && (
        <div className="animate-fade mt-1 mb-2 ml-5.5">
          {summary.note && <div className="mb-1.5 text-[12px] text-faint">{summary.note}</div>}
          <Detail call={call} cwd={cwd} outcome={outcome} />
        </div>
      )}
    </div>
  );
  if (!command) return step;
  const output = cleanOutput(resultText(call.result)).trim();
  if (!output) return step;
  return <SwipeQuote whole={{ text: () => output, from: () => ({ what: 'step', key: call.id }) }}>{step}</SwipeQuote>;
});

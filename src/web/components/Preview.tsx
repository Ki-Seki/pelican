import { Code2, Eye, Maximize2, Play, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { PREVIEW_POLICY } from '../../shared/preview-policy';
import { getPrefs } from '../lib/prefs';
import { Modal } from './Modal';

/**
 * Rendered HTML and SVG: pages Claude writes, `html`/`svg` blocks in a reply,
 * and the visuals Claude Desktop draws with its show_widget tool.
 *
 * A preview first shows as a still picture, in a frame where nothing runs (a sandbox that allows
 * nothing) and with nothing in it that loads by being there (frames, embeds, links and scripts are
 * taken out), so seeing a conversation runs nothing Claude wrote. Its scripts run only once you tap
 * Run, in a document of its own (preview.html) in a sandbox apart from Pelican, with no access to
 * it, its cookies or its API, under a content policy that lets it load scripts, styles and fonts
 * from the public CDNs and nothing else. A page whose scripts run can still reach other servers in
 * ways no policy covers (WebRTC, DNS), so running one is like opening it in a browser.
 */

export { PREVIEW_POLICY };

/**
 * First in every preview, before anything the page brings: the policy, no prefetching of names,
 * then a script that takes WebRTC away (a peer connection reaches its ICE servers whatever
 * connect-src says, and browsers do not know the policy's own webrtc directive yet).
 */
const STILL_PREAMBLE = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"><meta http-equiv="x-dns-prefetch-control" content="off">`;
const PREAMBLE = `${STILL_PREAMBLE}<script>for(const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport"])try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}</script>`;

/** HTML's own whitespace (not \s, which also takes in characters that HTML reads as text). */
const LEADING = /^[\t\n\f\r ]*/;

const isDark = () => {
  const theme = getPrefs().theme;
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
};

/** Styles for widget fragments, in the vocabulary Claude Desktop's visuals use (box, th, ts, arr, c-*). */
const WIDGET_CSS = `
:root{color-scheme:light;--bg:#ffffff;--surface:#fafaf8;--text:#1f1f1e;--muted:#6b6a64;--line:#d9d7cf;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",system-ui,sans-serif;font-size:14px;line-height:1.5}
:root[data-theme=dark]{color-scheme:dark;--bg:#121416;--surface:#1a1d20;--text:#ececea;--muted:#a5a8ae;--line:#3a3d42}
html,body{margin:0;background:transparent;color:var(--text)}
body{padding:2px}
svg{display:block;max-width:100%;height:auto}
svg text{fill:var(--text);font-family:inherit}
.th{font-size:14px;font-weight:600;fill:var(--text)}
.t{font-size:13px;fill:var(--text)}
.ts{font-size:12px;fill:var(--muted)}
.box{fill:var(--surface);stroke:var(--line)}
.arr{stroke:var(--muted);stroke-width:1.5;fill:none}
.c-purple{--tint:#7c6cf2}.c-teal{--tint:#0e9aa7}.c-blue{--tint:#3b82f6}.c-green{--tint:#22a06b}.c-amber,.c-orange{--tint:#e08a1e}.c-red{--tint:#e5484d}.c-pink{--tint:#d6409f}.c-gray{--tint:#8b8e94}
[class*="c-"] rect,rect[class*="c-"],[class*="c-"] circle,circle[class*="c-"],[class*="c-"] .box{fill:color-mix(in srgb,var(--tint) 13%,var(--bg));stroke:color-mix(in srgb,var(--tint) 60%,var(--bg))}
[class*="c-"] .th{fill:color-mix(in srgb,var(--tint) 65%,var(--text))}
`;

/** Tells the parent how tall the content is, so the frame fits it (only where scripts run). */
const RESIZE = `<script>(()=>{const post=()=>parent.postMessage({pelicanPreviewHeight:Math.ceil(document.documentElement.scrollHeight)},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>`;

export type PreviewSource = { kind: 'html' | 'svg'; code: string; title?: string; widget?: boolean };

const fullPage = (code: string) => /^(<!doctype|<html)/i.test(code.replace(/^\uFEFF/, '').slice(LEADING.exec(code)?.[0].length ?? 0));

/**
 * Elements that reach the network by being there, whatever the policy says: Chrome looks up a
 * frame's host name (DNS, which carries whatever the name holds) before the policy blocks the
 * frame, and a prerender fetches. A still preview has no use for any of them, nor for scripts.
 */
const LOADERS = 'iframe, frame, frameset, object, embed, portal, fencedframe, link, meta, base, script';

/** The markup with every loader taken out, also inside SVG, `<noscript>` and `<template>` (a shadow root). */
function withoutLoaders(code: string, page: boolean): string {
  // A document that loads and runs nothing, read as the still frame reads it: with scripting off,
  // so what is in a <noscript> is markup here as there.
  const doc = new DOMParser().parseFromString(page ? code : `<!doctype html><body>${code}`, 'text/html');
  const clean = (root: ParentNode) => {
    for (const element of root.querySelectorAll(LOADERS)) element.remove();
    for (const template of root.querySelectorAll('template')) clean(template.content);
  };
  clean(doc);
  return page ? doc.documentElement.outerHTML : doc.body.innerHTML;
}

/**
 * What a still preview shows of the code: no loaders. Read once more to be sure the frame reads
 * the same (markup can read differently a second time); when it does not, nothing is shown.
 */
function stillCode(code: string, page: boolean): string {
  if (typeof DOMParser === 'undefined') return '';
  const once = withoutLoaders(code, page);
  return withoutLoaders(once, page) === once ? once : '';
}

/** The document a preview shows; a still one carries no script of Pelican's (none could run), and nothing that loads. */
export function documentFor(source: PreviewSource, dark: boolean, still = false): string {
  const theme = dark ? 'dark' : 'light';
  const preamble = still ? STILL_PREAMBLE : PREAMBLE;
  const resize = still ? '' : RESIZE;
  const raw = source.code.replace(/^\uFEFF/, '');
  const code = still ? stillCode(raw, fullPage(raw)) : raw;
  const start = code.slice(LEADING.exec(code)?.[0].length ?? 0);
  if (fullPage(raw)) {
    // A page of its own: its own styles, plus the size report. Our doctype and preamble come
    // first, whatever the page starts with: the parser puts the policy in the head before any
    // of the page's own content, so it covers all of it. The page's doctype is dropped.
    const page = `<!doctype html>${preamble}${start.replace(/^<!doctype[^>]*>/i, '')}`;
    return /<\/body>/i.test(page) ? page.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${resize}</body>`) : `${page}${resize}`;
  }
  const css = source.widget || source.kind === 'svg' ? `<style>${WIDGET_CSS}</style>` : '<style>html,body{margin:0}body{font-family:-apple-system,system-ui,sans-serif}</style>';
  return `<!doctype html><html data-theme="${theme}"><head>${preamble}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body>${code}${resize}</body></html>`;
}

/** Whether the code looks like it has scripts to run (only to offer Run: nothing runs without it). */
export function hasScripts(code: string): boolean {
  return /<script\b|\son[a-z]+\s*=|javascript:/i.test(code);
}

/**
 * How tall a still SVG is at a width, from its viewBox (or its width and height): a frame where
 * nothing runs cannot say how tall it is, but a drawing's shape is in its first tag.
 */
export function stillHeight(source: PreviewSource, width: number): number | undefined {
  if (!width) return undefined;
  const code = source.code.slice(LEADING.exec(source.code)?.[0].length ?? 0);
  const tag = /^<svg\b[^>]*>/i.exec(code)?.[0];
  if (!tag) return undefined;
  const box = /\sviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/i.exec(tag);
  // A width or height in pixels (not a percentage, not stroke-width).
  const pixels = (name: string) => Number(new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)(?:px)?["'\\s/>]`, 'i').exec(tag)?.[1]);
  const [w, h] = box ? [Number(box[1]), Number(box[2])] : [pixels('width'), pixels('height')];
  if (!(w > 0) || !(h > 0)) return undefined;
  // The widget styles pad the body by 2px.
  return Math.ceil(width * (h / w)) + 4;
}

let runs = 0;

/**
 * The content in a sandboxed frame, as tall as it is (up to `max`). Still: a frame where nothing
 * runs, sized from the drawing or to a fixed height. Running: preview.html, which gets the page.
 */
export function Sandbox({ source, max = 640, fill = false, run = false }: { source: PreviewSource; max?: number; fill?: boolean; run?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const dark = isDark();
  const doc = useMemo(() => documentFor(source, dark, !run), [source, dark, run]);
  // A running frame gets its document once, so a new document takes a new frame.
  const key = useMemo(() => (run ? `run-${(runs += 1)}` : 'still'), [run, doc]);
  const [reported, setReported] = useState<number>();
  const [width, setWidth] = useState(0);
  const name = useId();

  useEffect(() => {
    setReported(undefined);
    if (!run) return undefined;
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const data = event.data as { pelicanPreviewHeight?: unknown; pelicanPreviewReady?: unknown } | undefined;
      // The frame's origin is opaque, so there is no origin to name; the page is what it shows anyway.
      if (data?.pelicanPreviewReady === true) target.postMessage({ pelicanPreview: doc }, '*');
      else if (typeof data?.pelicanPreviewHeight === 'number' && data.pelicanPreviewHeight > 0) setReported(data.pelicanPreviewHeight);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [run, doc, key]);

  useEffect(() => {
    const element = frame.current;
    if (!element || fill) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [fill, key]);

  const still = stillHeight(source, width);
  const height = reported ?? still ?? (source.kind === 'svg' ? 0 : fullPage(source.code) ? 360 : 240);
  return (
    <iframe
      key={key}
      ref={frame}
      name={name}
      title={source.title ?? 'Preview'}
      sandbox={run ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      {...(run ? { src: './preview.html' } : { srcDoc: doc })}
      className="block w-full border-0 bg-transparent"
      style={fill ? { height: '100%' } : { height: Math.min(Math.max(height, 48), max) }}
    />
  );
}

/** The quiet button that lets a preview's scripts run. */
function RunButton({ onRun }: { onRun: () => void }) {
  return (
    <button type="button" onClick={onRun} title="Run its scripts" className="flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover hover:text-fg">
      <Play className="size-3.5" />
      Run
    </button>
  );
}

// One full-screen preview at a time, opened from anywhere in the chat.
let current: { source: PreviewSource; run: boolean } | undefined;
const listeners = new Set<() => void>();
export function openPreview(source: PreviewSource | undefined, run = false): void {
  current = source ? { source, run } : undefined;
  for (const listener of listeners) listener();
}

export function PreviewOverlay() {
  const shown = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  // A dialog: focus goes in and comes back, one Esc closes it (Modal). Scripts wait for Run.
  const source = shown?.source;
  const run = Boolean(shown?.run);
  return (
    <Modal open={Boolean(source)} onClose={() => openPreview(undefined)} label={source?.title ?? 'Preview'}>
      {source && (
        <div className="animate-fade flex h-full flex-col bg-bg transition-opacity duration-200 group-data-closing/modal:opacity-0">
          <div className="pt-safe flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-faint">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{source.title ?? 'Preview'}</span>
            {!run && hasScripts(source.code) && <RunButton onRun={() => openPreview(source, true)} />}
            <button type="button" aria-label="Close preview" onClick={() => openPreview(undefined)} className="grid size-9 place-items-center rounded-full text-fg hover:bg-hover">
              <X className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-panel"><Sandbox source={source} run={run} fill /></div>
        </div>
      )}
    </Modal>
  );
}

/** A visual or a page, shown rendered, with a way to run its scripts, see its code and open it full screen. */
export function PreviewCard({ source, label, defaultCode = false }: { source: PreviewSource; label?: string; defaultCode?: boolean }) {
  const [code, setCode] = useState(defaultCode);
  const [run, setRun] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-9 items-center gap-1 border-b border-line pr-1 pl-3 text-[12px] text-faint">
        <span className="min-w-0 flex-1 truncate">{label ?? source.title ?? (source.kind === 'svg' ? 'SVG' : 'HTML')}</span>
        {!code && !run && hasScripts(source.code) && <RunButton onRun={() => setRun(true)} />}
        <button type="button" onClick={() => setCode((v) => !v)} className="flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover hover:text-fg" aria-pressed={code}>
          {code ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
          {code ? 'Preview' : 'Code'}
        </button>
        <button type="button" aria-label="Open full screen" onClick={() => openPreview(source, run)} className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      {code ? (
        <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted">{source.code}</pre>
      ) : (
        <div className="bg-bg"><Sandbox source={source} run={run} /></div>
      )}
    </div>
  );
}

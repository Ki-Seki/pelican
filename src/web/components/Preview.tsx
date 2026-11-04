import { Code2, Eye, Maximize2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { getPrefs } from '../lib/prefs';

/**
 * Rendered HTML and SVG: pages Claude writes, `html`/`svg` blocks in a reply,
 * and the visuals Claude Desktop draws with its show_widget tool.
 *
 * Everything renders in a sandboxed frame with no same-origin access: scripts
 * may run (charts, small apps), but they cannot reach Pelican, its cookies or
 * its API, open windows, submit forms or navigate the page. A content policy,
 * first in every document, keeps the page from talking to any server but the
 * public script and font CDNs, so what it shows stays on this screen.
 */

const CDNS = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com';

/** What a preview may load: scripts, styles and fonts from public CDNs; images only from itself. */
export const PREVIEW_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src data: https://fonts.gstatic.com ${CDNS}`,
  'img-src data: blob:',
  'media-src data: blob:',
  `connect-src ${CDNS}`,
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * First in every preview, before anything the page brings: the policy, then a script that takes
 * WebRTC away (a peer connection reaches its ICE servers whatever connect-src says, and browsers
 * do not know the policy's own webrtc directive yet).
 */
const PREAMBLE = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"><script>for(const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport"])try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}</script>`;

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

/** Tells the parent how tall the content is, so the frame fits it. */
const RESIZE = `<script>(()=>{const post=()=>parent.postMessage({pelicanPreviewHeight:Math.ceil(document.documentElement.scrollHeight)},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>`;

export type PreviewSource = { kind: 'html' | 'svg'; code: string; title?: string; widget?: boolean };

export function documentFor(source: PreviewSource, dark: boolean): string {
  const theme = dark ? 'dark' : 'light';
  const code = source.code.replace(/^\uFEFF/, '');
  const start = code.slice(LEADING.exec(code)?.[0].length ?? 0);
  const full = /^(<!doctype|<html)/i.test(start);
  if (full) {
    // A page of its own: its own styles, plus the size report. Our doctype and preamble come
    // first, whatever the page starts with: the parser puts the policy in the head before any
    // of the page's own content, so it covers all of it. The page's doctype is dropped.
    const page = `<!doctype html>${PREAMBLE}${start.replace(/^<!doctype[^>]*>/i, '')}`;
    return /<\/body>/i.test(page) ? page.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${RESIZE}</body>`) : `${page}${RESIZE}`;
  }
  const css = source.widget || source.kind === 'svg' ? `<style>${WIDGET_CSS}</style>` : '<style>html,body{margin:0}body{font-family:-apple-system,system-ui,sans-serif}</style>';
  return `<!doctype html><html data-theme="${theme}"><head>${PREAMBLE}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body>${code}${RESIZE}</body></html>`;
}

/** The rendered content in a sandboxed frame, as tall as it is (up to `max`). */
export function Sandbox({ source, max = 640, fill = false }: { source: PreviewSource; max?: number; fill?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(source.kind === 'svg' ? 0 : 160);
  const dark = isDark();
  const doc = useMemo(() => documentFor(source, dark), [source, dark]);
  const name = useId();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const reported = (event.data as { pelicanPreviewHeight?: unknown } | undefined)?.pelicanPreviewHeight;
      if (typeof reported === 'number' && reported > 0) setHeight(reported);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      name={name}
      title={source.title ?? 'Preview'}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="block w-full border-0 bg-transparent"
      style={fill ? { height: '100%' } : { height: Math.min(Math.max(height, 48), max) }}
    />
  );
}

// One full-screen preview at a time, opened from anywhere in the chat.
let current: PreviewSource | undefined;
const listeners = new Set<() => void>();
export function openPreview(source: PreviewSource | undefined): void {
  current = source;
  for (const listener of listeners) listener();
}

export function PreviewOverlay() {
  const source = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openPreview(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source]);
  if (!source) return null;
  return createPortal(
    <div className="animate-fade fixed inset-0 z-[60] flex flex-col bg-bg">
      <div className="pt-safe flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{source.title ?? 'Preview'}</span>
        <button type="button" aria-label="Close preview" onClick={() => openPreview(undefined)} className="grid size-9 place-items-center rounded-full hover:bg-hover">
          <X className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-panel"><Sandbox source={source} fill /></div>
    </div>,
    document.body,
  );
}

/** A visual or a page, shown rendered, with a way to see its code and to open it full screen. */
export function PreviewCard({ source, label, defaultCode = false }: { source: PreviewSource; label?: string; defaultCode?: boolean }) {
  const [code, setCode] = useState(defaultCode);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-9 items-center gap-1 border-b border-line pr-1 pl-3 text-[12px] text-faint">
        <span className="min-w-0 flex-1 truncate">{label ?? source.title ?? (source.kind === 'svg' ? 'SVG' : 'HTML')}</span>
        <button type="button" onClick={() => setCode((v) => !v)} className="flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover hover:text-fg" aria-pressed={code}>
          {code ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
          {code ? 'Preview' : 'Code'}
        </button>
        <button type="button" aria-label="Open full screen" onClick={() => openPreview(source)} className="grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      {code ? (
        <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted">{source.code}</pre>
      ) : (
        <div className="bg-bg"><Sandbox source={source} /></div>
      )}
    </div>
  );
}

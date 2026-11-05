import { ArrowUpRight, Check, Copy, Image as ImageIcon } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { openImage } from './Lightbox';
import { PreviewCard } from './Preview';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      // Looks 28px, takes a finger's 44px.
      className={`relative grid size-7 place-items-center rounded-md text-faint after:absolute after:-inset-2 hover:bg-hover hover:text-fg ${className}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * Whether an image may load in the page: only from Pelican itself, or data already in it.
 * Loading a picture from another server tells that server whatever its address carries, so a
 * reply could leak the conversation without a tap (and the page's policy blocks it anyway).
 */
export function loadsInPlace(src: string): boolean {
  if (src.startsWith('data:image/') || src.startsWith('blob:')) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** An image on another site: named, and opened there on a tap, never loaded into the page. */
export function RemoteImage({ src, alt }: { src: string; alt?: string }) {
  let host = '';
  try {
    host = new URL(src).host;
  } catch {
    // Not a URL: shown as text only.
  }
  const label = <><ImageIcon className="size-3.5 shrink-0" /><span className="truncate">{alt ? `${alt} · ` : 'Image · '}{host || 'not shown'}</span></>;
  if (!/^https?:\/\//i.test(src)) return <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-chip px-2 py-1 text-[12px] text-faint">{label}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer noopener" title={src} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-chip px-2 py-1 text-[12px] text-muted no-underline hover:text-fg">
      {label}
      <ArrowUpRight className="size-3 shrink-0" />
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const language = /language-(\w+)/.exec(String((children as { props?: { className?: string } } | undefined)?.props?.className ?? ''))?.[1];
    // HTML and SVG in a reply can be seen rendered too; it starts as code, the way it was written.
    if (language === 'html' || language === 'svg') {
      return <div className="my-2"><PreviewCard source={{ kind: language, code: textOf(children) }} label={language.toUpperCase()} defaultCode /></div>;
    }
    // The copy button has a bar of its own, as in Claude's apps: over the code, it hid the first
    // line of every block that scrolls sideways.
    return (
      <div className="my-[0.6em] overflow-hidden rounded-[10px] border border-line bg-panel">
        <div className="flex h-8 items-center gap-2 border-b border-line pr-1 pl-3 text-[11.5px] text-faint select-none">
          <span className="min-w-0 flex-1 truncate">{language}</span>
          <CopyButton text={textOf(children)} />
        </div>
        <pre className="m-0! rounded-none! border-0!">{children}</pre>
      </div>
    );
  },
  img: ({ src, alt }) => {
    if (typeof src !== 'string' || !src) return null;
    if (!loadsInPlace(src)) return <RemoteImage src={src} {...(alt ? { alt } : {})} />;
    return (
      <button type="button" aria-label={alt || 'Open image'} className="block max-w-full" onClick={() => openImage(src)}>
        <img src={src} alt={alt ?? ''} className="max-h-80 max-w-full rounded-lg border border-line" />
      </button>
    );
  },
};

// Line breaks are kept, as in Claude's own apps: output like logs and lists of numbers stays readable.
const remarkPlugins = [remarkGfm, remarkBreaks];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`prose-chat ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

import { Check, Copy } from 'lucide-react';
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
      className={`grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg ${className}`}
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
    return (
      <div className="group relative">
        {/* Room on the right for the copy button, so it never covers the end of a line. */}
        <pre className="pr-10">{children}</pre>
        <CopyButton text={textOf(children)} className="absolute top-1.5 right-1.5 bg-panel opacity-70 group-hover:opacity-100" />
      </div>
    );
  },
  img: ({ src, alt }) => (typeof src === 'string' && src ? (
    <button type="button" className="block max-w-full" onClick={() => openImage(src)}>
      <img src={src} alt={alt ?? ''} className="max-h-80 max-w-full rounded-lg border border-line" />
    </button>
  ) : null),
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

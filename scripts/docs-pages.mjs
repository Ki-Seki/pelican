// The docs, one page per topic: site/docs-src holds each page's content and pages.json their
// order, groups, titles and descriptions; this wraps each in the docs' own frame (header with
// search, contents, on this page, previous and next) and writes docs.html (the overview, where
// the docs have always been) and docs/<page>.html. A link to an anchor on another page goes to that
// page, and docs.html sends an anchor that moved (docs.html#phone) on to its page, so every link
// made to the one-page docs still lands. Also writes assets/search.json, what search looks through.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://ki-seki.github.io/pelican/';
const REPO = 'https://github.com/Ki-Seki/pelican';
const SRC = 'site/docs-src';

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
/** Where a page is, from the site's root. */
const urlOf = (page) => (page.slug ? `docs/${page.slug}.html` : 'docs.html');

const ICON = {
  search: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  terminal: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>',
  edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/></svg>',
  left: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
};

/** What the docs say, ready to wrap: each page with its content, the ids on it, and where it is. */
async function readPages() {
  const pages = JSON.parse(await readFile(path.join(SRC, 'pages.json'), 'utf8'));
  for (const page of pages) {
    page.html = await readFile(path.join(SRC, page.file), 'utf8');
    page.url = urlOf(page);
    page.anchors = new Set([...page.html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  }
  return pages;
}

/** The page an id is on, for links and for the anchors that moved: a section's id names its page. */
function idMap(pages) {
  const map = new Map();
  for (const page of pages) {
    for (const id of page.ids ?? []) map.set(id, { page, hash: '' });
    for (const id of page.anchors) {
      if (map.has(id) && map.get(id).page !== page) throw new Error(`#${id} is on ${map.get(id).page.file} and ${page.file}`);
      map.set(id, { page, hash: `#${id}` });
    }
  }
  return map;
}

/** A link from `from` to `to` (both from the site's root), as a relative URL. */
function relative(from, to) {
  const up = from.includes('/') ? '../' : '';
  return up + to;
}

/** The page's content with its links pointing where they land from where the page is. */
function linked(page, pages, ids) {
  const root = page.url.includes('/') ? '../' : '';
  return page.html
    .replace(/\b(href|src)="([^"]*)"/g, (all, attr, value) => {
      if (attr === 'href' && value.startsWith('#page-')) {
        const target = pages.find((p) => (p.slug || 'overview') === value.slice(6));
        if (!target) throw new Error(`${page.file}: no page ${value}`);
        return `href="${relative(page.url, target.url)}"`;
      }
      const anchor = attr === 'href' && (value.startsWith('#') ? value.slice(1) : value.startsWith('docs.html#') ? value.slice(10) : undefined);
      if (anchor !== undefined && anchor !== false) {
        if (page.anchors.has(anchor)) return `href="#${anchor}"`;
        const where = ids.get(anchor);
        if (!where) throw new Error(`${page.file}: the link to #${anchor} goes nowhere`);
        return `href="${relative(page.url, where.page.url)}${where.hash}"`;
      }
      if (/^(https?:|mailto:|#|\/|data:|\.\.\/)/.test(value) || !root) return all;
      return `${attr}="${root}${value}"`;
    })
    // A block of commands is something to run in a terminal: it says so, above it.
    .replace(/<pre><code>/g, `<figure class="codeblock"><figcaption>${ICON.terminal}Terminal</figcaption><pre><code>`)
    .replace(/<\/code><\/pre>/g, '</code></pre></figure>');
}

const head = (page, root) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.slug ? `${page.title} · Pelican docs` : 'Docs · Pelican')}</title>
<meta name="description" content="${escape(page.description)}">
<link rel="canonical" href="${SITE}${page.url}">
<meta name="theme-color" content="#fbfbfa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0c0d" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pelican">
<meta property="og:url" content="${SITE}${page.url}">
<meta property="og:title" content="${escape(page.slug ? `${page.title} · Pelican docs` : 'Pelican docs')}">
<meta property="og:description" content="${escape(page.description)}">
<meta property="og:image" content="${SITE}assets/shots/og.png">
<meta property="og:image:alt" content="Pelican: every Claude Code session on your computer, on your phone. Two phone screens: the session list, and an edit waiting for approval with its diff.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}assets/shots/og.png">
<link rel="icon" href="${root}assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}assets/site.css">
<script type="module" src="${root}assets/site.js"></script>
</head>`;

function frame(page, pages, ids) {
  const root = page.url.includes('/') ? '../' : '';
  const html = linked(page, pages, ids);
  const groups = [...new Set(pages.map((p) => p.group))];
  const contents = groups.map((group) => `        <p class="toc-group">${escape(group)}</p>\n${pages.filter((p) => p.group === group).map((p) => `        <a href="${relative(page.url, p.url)}"${p === page ? ' aria-current="page"' : ''}>${escape(p.nav)}</a>`).join('\n')}`).join('\n');
  // On this page: its headings, with ids, in order.
  const heads = [...html.matchAll(/<h2 id="([^"]+)"[^>]*>(.*?)<\/h2>/g)].map((m) => `<a href="#${m[1]}">${escape(plain(m[2]))}</a>`);
  const at = pages.indexOf(page);
  const prev = pages[at - 1];
  const next = pages[at + 1];
  const pager = [
    prev ? `<a class="prev" href="${relative(page.url, prev.url)}">${ICON.left}<span><small>Previous</small><b>${escape(prev.nav)}</b></span></a>` : '<span></span>',
    next ? `<a class="next" href="${relative(page.url, next.url)}"><span><small>Next</small><b>${escape(next.nav)}</b></span>${ICON.right}</a>` : '<span></span>',
  ].join('');
  // The overview is where the one-page docs were: an anchor that moved goes on to its page.
  const moved = page.slug ? '' : `\n<script>(() => { const to = ${JSON.stringify(Object.fromEntries([...ids].filter(([, w]) => w.page !== page).map(([id, w]) => [id, w.page.url + w.hash])))}; const id = decodeURIComponent(location.hash.slice(1)); if (id && to[id] && !document.getElementById(id)) location.replace(to[id]); })();</script>`;
  return `${head(page, root)}
<body class="docs-page">${moved}

<header class="top docs-top">
  <div class="wrap">
    <a class="brand" href="${root || './'}" aria-label="Pelican"><img src="${root}assets/logo.svg" alt=""><span>Pelican</span></a>
    <a class="brand-docs" href="${relative(page.url, 'docs.html')}">Docs</a>
    <div class="search" data-index="${root}assets/search.json" data-root="${root}">
      ${ICON.search}
      <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" aria-controls="search-results">
      <kbd aria-hidden="true">⌘K</kbd>
      <div class="results" id="search-results" role="listbox" aria-label="Results" hidden></div>
    </div>
    <nav class="nav" aria-label="Site">
      <a href="${root}demo/" class="wide-only">Live demo</a>
      <a href="${REPO}/blob/main/CHANGELOG.md" class="wide-only">Changelog</a>
      <a class="gh" href="${REPO}" aria-label="GitHub">${ICON.github}<span class="wide-only">GitHub</span></a>
    </nav>
  </div>
</header>

<div class="wrap docs-layout">
  <aside class="sidebar">
    <details class="toc-wrap" open>
      <summary><span><small>${escape(page.group)}</small>${escape(page.nav)}</span></summary>
      <nav class="toc" aria-label="Docs">
${contents}
      </nav>
    </details>
  </aside>

  <article class="docs">
    <p class="eyebrow">${escape(page.group)}</p>
    <h1>${escape(page.title)}</h1>
    <p class="lead">${escape(page.description)}</p>
${html}
    <div class="page-foot"><a class="edit" href="${REPO}/edit/main/${SRC}/${page.file}">${ICON.edit}Edit this page on GitHub</a></div>
    <nav class="pager" aria-label="Previous and next pages">${pager}</nav>
  </article>

  <nav class="onpage" aria-label="On this page"${heads.length ? '' : ' hidden'}><p>On this page</p><div class="onpage-links">${heads.join('')}</div></nav>
</div>

<footer class="foot">
  <div class="wrap">
    <a class="brand" href="${root || './'}"><img src="${root}assets/logo.svg" alt="">Pelican</a>
    <nav aria-label="Footer">
      <a href="${relative(page.url, 'docs.html')}">Docs</a>
      <a href="${root}demo/">Live demo</a>
      <a href="${REPO}">GitHub</a>
      <a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a>
      <a href="${REPO}/blob/main/LICENSE">MIT license</a>
    </nav>
    <p>Pelican is an independent project, not made by or affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.</p>
  </div>
</footer>

</body>
</html>
`;
}

/** What search looks through: each heading with what follows it, on its page. */
function searchIndex(pages, ids) {
  const entries = [];
  for (const page of pages) {
    const html = linked(page, pages, ids);
    entries.push({ url: page.url, title: page.title, heading: page.title, text: page.description });
    const parts = html.split(/(?=<h2 id=")/);
    for (const part of parts) {
      const m = /^<h2 id="([^"]+)"[^>]*>(.*?)<\/h2>/s.exec(part);
      const text = plain(m ? part.slice(m[0].length) : part);
      if (!m && !text) continue;
      entries.push({ url: page.url + (m ? `#${m[1]}` : ''), title: page.title, heading: m ? plain(m[2]) : page.title, text: text.slice(0, 2000) });
    }
  }
  return entries;
}

/** Writes the docs into the site being assembled in `out`. */
export async function buildDocs(out) {
  const pages = await readPages();
  const ids = idMap(pages);
  await mkdir(path.join(out, 'docs'), { recursive: true });
  for (const page of pages) await writeFile(path.join(out, page.url), frame(page, pages, ids));
  await writeFile(path.join(out, 'assets', 'search.json'), JSON.stringify(searchIndex(pages, ids)));
  return pages.map((p) => p.url);
}

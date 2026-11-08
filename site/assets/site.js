// What the site does: a line under the header once the page scrolls, copy buttons on commands,
// and, on the docs page, the table of contents following the section being read. The text never
// depends on it.
const COPY = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const DONE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const top = document.querySelector('.top');
const onScroll = () => top?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

for (const block of document.querySelectorAll('.cmd, pre.code, .docs pre')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy');
  button.innerHTML = COPY;
  button.addEventListener('click', async () => {
    const text = block.querySelector('code').innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    button.innerHTML = DONE;
    button.classList.add('done');
    setTimeout(() => {
      button.innerHTML = COPY;
      button.classList.remove('done');
    }, 1400);
  });
  (block.closest('.codeblock')?.querySelector('figcaption') ?? block).append(button);
}

const toc = document.querySelector('.toc');
const links = [...document.querySelectorAll('.toc a[href^="#"]')];
const targets = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)));
// The section being read is the last one whose start has passed under the header. Measured on
// scroll rather than watched, so it is right wherever a jump or a reload lands.
let pending = false;
function follow() {
  pending = false;
  let current = 0;
  targets.forEach((target, i) => {
    if (target && target.getBoundingClientRect().top < 120) current = i;
  });
  links.forEach((a, i) => a.classList.toggle('active', i === current));
  // A long contents list scrolls on its own: keep the current entry in sight.
  const link = links[current];
  const scroller = document.querySelector('.sidebar') ?? toc;
  if (scroller && link && scroller.scrollHeight > scroller.clientHeight) {
    const top = link.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (top < scroller.scrollTop + 60) scroller.scrollTop = top - 60;
    else if (top + link.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + link.offsetHeight - scroller.clientHeight + 8;
  }
}
if (links.length > 0) {
  addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(follow);
  }, { passive: true });
  follow();
}

// ------------------------------------------------------------------ docs
// What the docs do beyond their text, which reads whole without it (every tab's panel shows, the
// contents stay open, there is no search): a link on each heading, tabs, the contents folded on a
// phone, the heading being read marked on this page, and search over all the pages.
document.documentElement.classList.add('js');
const docs = document.querySelector('.docs');
const narrow = () => matchMedia('(max-width: 900px)').matches;

if (docs) {
  for (const heading of docs.querySelectorAll('h2[id], h3[id]')) {
    const anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = `#${heading.id}`;
    anchor.setAttribute('aria-label', `Link to ${heading.textContent}`);
    anchor.textContent = '#';
    heading.append(anchor);
  }
}

// On a phone the contents start folded under the page's name.
const tocWrap = document.querySelector('.toc-wrap');
if (tocWrap && narrow()) tocWrap.open = false;

// Tabs: one system at a time, starting on the one this browser runs on.
for (const group of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
  const pick = (i, focus = false) => {
    tabs.forEach((tab, j) => {
      tab.setAttribute('aria-selected', String(i === j));
      tab.tabIndex = i === j ? 0 : -1;
      panels[j].hidden = i !== j;
    });
    if (focus) tabs[i].focus();
  };
  const ua = navigator.userAgent;
  const guess = /Windows/.test(ua) ? tabs.findIndex((t) => /WSL/.test(t.textContent)) : /Linux|X11/.test(ua) && !/Android/.test(ua) ? tabs.findIndex((t) => /Linux/.test(t.textContent)) : 0;
  pick(Math.max(0, guess));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => pick(i));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (step) { e.preventDefault(); pick((i + step + tabs.length) % tabs.length, true); }
    });
  });
}

// On this page: the heading being read, marked.
const onpageLinks = [...document.querySelectorAll('.onpage-links a')];
if (onpageLinks.length > 0) {
  const heads = onpageLinks.map((a) => document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))));
  let queued = false;
  const mark = () => {
    queued = false;
    let current = -1;
    heads.forEach((h, i) => { if (h && h.getBoundingClientRect().top < 120) current = i; });
    onpageLinks.forEach((a, i) => a.classList.toggle('active', i === current));
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(mark); } }, { passive: true });
  mark();
}

// Search over every page of the docs: what each heading says, word by word, a click or Enter away.
const searchBox = document.querySelector('.search[data-index]');
const search = searchBox?.querySelector('input');
const results = searchBox?.querySelector('.results');
if (searchBox && search && results) {
  const root = searchBox.dataset.root ?? '';
  let index;
  const load = () => (index ??= fetch(searchBox.dataset.index).then((r) => r.json()).catch(() => []));
  let active = 0;
  let found = [];
  const escape = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const show = async () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) { results.hidden = true; return; }
    const entries = await load();
    const score = (e) => words.reduce((n, w) => n + (e.heading.toLowerCase().includes(w) ? 3 : 0) + (e.title.toLowerCase().includes(w) ? 1 : 0), 0);
    found = entries.filter((e) => words.every((w) => `${e.title} ${e.heading} ${e.text}`.toLowerCase().includes(w)))
      .sort((a, b) => score(b) - score(a)).slice(0, 8);
    active = 0;
    results.innerHTML = found.length === 0 ? '<p class="none">Nothing found</p>' : found.map((e, i) => {
      const at = e.text.toLowerCase().indexOf(words[0]);
      const from = Math.max(0, at - 40);
      const snippet = at < 0 ? e.text.slice(0, 110) : (from > 0 ? '…' : '') + e.text.slice(from, from + 110) + (from + 110 < e.text.length ? '…' : '');
      const where = e.heading === e.title ? e.title : `${e.title} › ${e.heading}`;
      return `<a role="option" href="${root}${e.url}" aria-selected="${i === 0}"><b>${escape(where)}</b><span>${escape(snippet)}</span></a>`;
    }).join('');
    results.hidden = false;
  };
  search.addEventListener('input', show);
  search.addEventListener('focus', () => { load(); show(); });
  search.addEventListener('keydown', (e) => {
    const links = [...results.querySelectorAll('a')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (links.length === 0) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links.forEach((a, i) => a.setAttribute('aria-selected', String(i === active)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (links[active]) location.href = links[active].href;
    } else if (e.key === 'Escape') {
      results.hidden = true;
      search.blur();
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });
  // `/`, or ⌘K and Ctrl+K, starts a search from anywhere on the page.
  addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, [contenteditable="true"]');
    if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) searchBox.querySelector('kbd').textContent = 'Ctrl K';
}

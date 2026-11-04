// What the site does: a line under the header once the page scrolls, copy buttons on commands,
// and, on the docs page, the table of contents following the section in view.
const COPY = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const DONE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const top = document.querySelector('.top');
const onScroll = () => top?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Comments (after #) are not copied, and neither are blank lines.
for (const block of document.querySelectorAll('.cmd, pre.code, .docs pre')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy');
  button.innerHTML = COPY;
  button.addEventListener('click', async () => {
    const text = block.querySelector('code').innerText.split('\n')
      .map((line) => line.replace(/\s+#\s.*$/, '').trimEnd())
      .filter((line) => line && !line.startsWith('#'))
      .join('\n');
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
  block.append(button);
}

const links = [...document.querySelectorAll('.toc a[href^="#"]')];
if (links.length > 0 && 'IntersectionObserver' in window) {
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const a of links) a.classList.toggle('active', a === byId.get(entry.target.id));
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  for (const id of byId.keys()) {
    const target = document.getElementById(id);
    if (target) observer.observe(target);
  }
}

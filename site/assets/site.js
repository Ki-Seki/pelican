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
  block.append(button);
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
  if (toc && link && toc.scrollHeight > toc.clientHeight) {
    if (link.offsetTop < toc.scrollTop) toc.scrollTop = link.offsetTop - 8;
    else if (link.offsetTop + link.offsetHeight > toc.scrollTop + toc.clientHeight) toc.scrollTop = link.offsetTop + link.offsetHeight - toc.clientHeight + 8;
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

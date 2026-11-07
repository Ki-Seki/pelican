// The README's and the site's screenshots, from the demo (made-up sessions; nothing of yours is shown).
//   npm run build && npm run screenshots      (CHROME=/path/to/chrome if it is not in the usual place;
//                                              PELICAN_DEMO_PORT if 47860 is taken)
// Writes docs/shots/{phone,desktop,list,live}-{light,dark}.png; with --og, og.png too, the picture
// shared links show, which is otherwise kept as uploaded.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { startDemo } from './demo-server.mjs';

const PORT = Number(process.env.PELICAN_DEMO_PORT ?? 47860);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = 'docs/shots';
const WAITING = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';
const CHART = 'f3a6e9b5-6666-4f60-9182-000000000006';
/** A session Claude Desktop is working on: what the site shows under "Wherever you started it". */
const ELSEWHERE = 'b7e2a9c1-2222-4b2c-9d4e-000000000002';

const demo = await startDemo({ port: PORT });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
await mkdir(OUT, { recursive: true });

/** The app's height inside the site's phone frame, under its status bar (site.css: 844px less 40px at the frame's scale). */
const FRAMED_HEIGHT = 796;

/** Before each picture: the demo's own notice goes (the README says the sessions are made up). */
const tidy = () => {
  document.querySelector('[data-demo-banner]')?.remove();
};

/**
 * In each page of the phone, from its start: whether it has read a mouse instead of a finger. The
 * app sizes its buttons, and lays out a prompt's actions, by the pointer it reads.
 */
const watchPointer = () => {
  const finger = [matchMedia('(pointer: coarse)'), matchMedia('(hover: none)')];
  const check = () => {
    if (finger.some((query) => !query.matches)) window.pelicanReadMouse = true;
  };
  window.pelicanReadMouse = false;
  check();
  for (const query of finger) query.addEventListener('change', check);
};
/** Whether the page has read a mouse, or reads one now (a change can be told a moment late). */
const readMouse = () => window.pelicanReadMouse || !matchMedia('(pointer: coarse)').matches || !matchMedia('(hover: none)').matches;

/** A phone that tall, touch and all. */
async function phone(scheme, height) {
  const context = await browser.newContext({
    viewport: { width: 390, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme,
  });
  await context.addInitScript(watchPointer);
  return { context, page: await context.newPage() };
}

/**
 * The phone's picture of a page: opened, made ready, tidied. Chrome's phone forgets now and then
 * that it has a touch screen (in the first phone, a few seconds in, until the next page opens),
 * and a page then draws a computer's buttons and rows: one that read a mouse at any time before
 * its picture was taken is opened again and pictured again.
 */
async function phoneShot(page, url, settle, ready = async () => {}) {
  for (let tries = 0; tries < 4; tries += 1) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(settle);
    await ready();
    await page.evaluate(tidy);
    const shot = await page.screenshot();
    if (!(await page.evaluate(readMouse))) return shot;
  }
  throw new Error(`${url} kept reading a mouse, not a finger: its picture would not be a phone's`);
}

async function phoneShots(scheme) {
  const { context, page } = await phone(scheme, 844);
  const shots = [
    await phoneShot(page, BASE, 500),
    await phoneShot(page, `${BASE}?s=${WAITING}`, 700),
    // A chart Claude drew, rendered in place.
    await phoneShot(page, `${BASE}?s=${CHART}`, 1200, async () => {
      await page.evaluate(() => document.querySelectorAll('.overscroll-contain').forEach((el) => { el.scrollTop = 0; }));
      await page.waitForTimeout(500);
      // Scrolled up to the chart, the conversation offers a way back to its end; a picture needs none.
      await page.evaluate(() => document.querySelector('[aria-label="Jump to latest"]')?.remove());
    }),
  ];
  await context.close();
  // The site's phone frames draw a status bar over the top 40px (about 48px of the app at their
  // scale), so the pictures that go in them are taken that much shorter, to show the whole screen,
  // on a phone that tall from the start.
  const framed = await phone(scheme, FRAMED_HEIGHT);
  const list = await phoneShot(framed.page, BASE, 500);
  const live = await phoneShot(framed.page, `${BASE}?s=${ELSEWHERE}`, 700);
  await framed.context.close();
  return { shots, live, list };
}

/** Three phone screens side by side, each with rounded corners, on the page color. */
async function strip(shots, scheme, file) {
  const bg = scheme === 'dark' ? '#0d1117' : '#ffffff';
  const line = scheme === 'dark' ? '#30363d' : '#d0d7de';
  const images = shots.map((png) => `<img src="data:image/png;base64,${png.toString('base64')}">`).join('');
  const page = await browser.newPage({ viewport: { width: 1280, height: 920 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>
    html,body{margin:0;background:${bg}}
    .row{display:flex;gap:40px;justify-content:center;padding:28px 0}
    img{width:390px;height:844px;border-radius:36px;border:1px solid ${line};display:block}
  </style><div class="row">${images}</div>`);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}

async function desktopShot(scheme, file) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(`${BASE}?s=${WAITING}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.evaluate(tidy);
  await page.screenshot({ path: path.join(OUT, file) });
  await context.close();
}

/** The picture links get when shared (Open Graph): the name, the line, and two screens. */
async function socialCard(shots) {
  const [list, chat] = shots.map((png) => `data:image/png;base64,${png.toString('base64')}`);
  const logo = (await readFile('docs/logo.svg', 'utf8')).replace('width="64" height="64"', 'width="76" height="76"');
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>
    html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fbfbfa;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;color:#141515}
    .copy{position:absolute;left:80px;top:118px;width:560px}
    .brand{display:flex;align-items:center;gap:20px}
    .brand svg{flex:none}
    h1{margin:0;font-size:92px;line-height:1;font-weight:700;letter-spacing:-0.045em}
    p{margin:34px 0 0;font-size:38px;line-height:1.2;font-weight:650;letter-spacing:-0.025em}
    p.second{margin-top:18px;font-size:26px;line-height:1.4;font-weight:400;letter-spacing:-0.005em;color:#55585d}
    .phones{position:absolute;right:-40px;top:60px;display:flex;align-items:flex-start;gap:26px;transform:rotate(-6deg)}
    .phones img{width:250px;height:auto;flex:none;border-radius:28px;border:9px solid #0c0d0e;box-shadow:0 30px 60px -20px rgba(0,0,0,.35)}
    .phones img:last-child{margin-top:70px}
  </style>
  <div class="copy"><div class="brand">${logo}<h1>Pelican</h1></div>
  <p>Every Claude Code session on your computer, on your phone.</p><p class="second">No wrapper, no relay, no account.</p></div>
  <div class="phones"><img src="${list}"><img src="${chat}"></div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'og.png') });
  await page.close();
}

for (const scheme of ['light', 'dark']) {
  const { shots, live, list } = await phoneShots(scheme);
  await strip(shots, scheme, `phone-${scheme}.png`);
  await writeFile(path.join(OUT, `list-${scheme}.png`), list);
  await writeFile(path.join(OUT, `live-${scheme}.png`), live);
  if (scheme === 'light' && process.argv.includes('--og')) await socialCard(shots);
  await desktopShot(scheme, `desktop-${scheme}.png`);
}
await browser.close();
await demo.stop();
console.log(`screenshots written to ${OUT}/`);

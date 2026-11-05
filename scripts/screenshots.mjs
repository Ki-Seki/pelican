// The README's screenshots, from the demo (made-up sessions; nothing of yours is shown).
//   npm run build && npm run screenshots      (CHROME=/path/to/chrome if it is not in the usual place)
// Writes docs/shots/{phone,desktop,list}-{light,dark}.png and og.png, the picture shared links show.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { startDemo } from './demo-server.mjs';

const PORT = 47860;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = 'docs/shots';
const WAITING = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';
const CHART = 'f3a6e9b5-6666-4f60-9182-000000000006';

const demo = await startDemo({ port: PORT });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
await mkdir(OUT, { recursive: true });

/**
 * Before each picture: the demo's own notice goes (the README says the sessions are made up),
 * and so does the round "jump to latest" button, which is a moment of scrolling, not the screen.
 */
const tidy = () => {
  document.querySelector('[data-demo-banner]')?.remove();
  document.querySelector('button[aria-label="Jump to latest"]')?.remove();
};

async function phoneShots(scheme) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme,
  });
  const page = await context.newPage();
  const shots = [];
  // The demo's own notice says these sessions are made up; the README says so instead.
  const grab = async () => {
    await page.evaluate(tidy);
    shots.push(await page.screenshot());
  };
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await grab();
  await page.goto(`${BASE}?s=${WAITING}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await grab();
  // A chart Claude drew, rendered in place.
  await page.goto(`${BASE}?s=${CHART}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelectorAll('.overscroll-contain').forEach((el) => { el.scrollTop = 0; }));
  await page.waitForTimeout(500);
  await grab();
  await context.close();
  return shots;
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
  const logo = (await readFile('docs/logo.svg', 'utf8')).replace('width="64" height="64"', 'width="56" height="56"');
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>
    html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fbfbfa;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;color:#141515}
    .copy{position:absolute;left:80px;top:150px;width:520px}
    .brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:650;letter-spacing:-0.02em}
    h1{margin:34px 0 0;font-size:64px;line-height:1.02;font-weight:700;letter-spacing:-0.045em}
    h1 span{color:#8b8e94}
    p{margin:22px 0 0;font-size:24px;line-height:1.45;color:#55585d}
    .phones{position:absolute;right:-30px;top:60px;display:flex;align-items:flex-start;gap:26px;transform:rotate(-6deg)}
    .phones img{width:270px;height:auto;flex:none;border-radius:30px;border:9px solid #0c0d0e;box-shadow:0 30px 60px -20px rgba(0,0,0,.35)}
    .phones img:last-child{margin-top:70px}
  </style>
  <div class="copy"><div class="brand">${logo}Pelican</div><h1>Claude Code,<br><span>in your pocket.</span></h1><p>Every session, live, from your phone. Open source; runs on your computer.</p></div>
  <div class="phones"><img src="${list}"><img src="${chat}"></div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'og.png') });
  await page.close();
}

for (const scheme of ['light', 'dark']) {
  const shots = await phoneShots(scheme);
  await strip(shots, scheme, `phone-${scheme}.png`);
  await writeFile(path.join(OUT, `list-${scheme}.png`), shots[0]);
  if (scheme === 'light') await socialCard(shots);
  await desktopShot(scheme, `desktop-${scheme}.png`);
}
await browser.close();
await demo.stop();
console.log(`screenshots written to ${OUT}/`);

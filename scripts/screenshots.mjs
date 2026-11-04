// The README's screenshots, from the demo (made-up sessions; nothing of yours is shown).
//   npm run build && npm run screenshots      (CHROME=/path/to/chrome if it is not in the usual place)
// Writes docs/shots/{phone,desktop}-{light,dark}.png.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright-core';

const PORT = 47860;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = 'docs/shots';
const WAITING = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';
const EXPORT = 'b7e2a9c1-2222-4b2c-9d4e-000000000002';

const server = spawn(process.execPath, ['dist/server/index.js', '--demo', '--name', 'laptop', '--port', String(PORT)], { stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);
for (let i = 0; ; i += 1) {
  try {
    if ((await fetch(`${BASE}api/info`)).ok) break;
  } catch {
    if (i > 50) throw new Error('The demo server did not start (is the app built?)');
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
await mkdir(OUT, { recursive: true });

async function phoneShots(scheme) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme,
  });
  const page = await context.newPage();
  const shots = [];
  // The demo's own notice says these sessions are made up; the README says so instead.
  const grab = async () => {
    await page.evaluate(() => document.querySelector('[data-demo-banner]')?.remove());
    shots.push(await page.screenshot());
  };
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await grab();
  await page.goto(`${BASE}?s=${WAITING}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await grab();
  await page.goto(`${BASE}?s=${EXPORT}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Run/ }).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll('.overscroll-contain').forEach((el) => { el.scrollTop = el.scrollHeight; }));
  await page.waitForTimeout(400);
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
  await page.evaluate(() => document.querySelector('[data-demo-banner]')?.remove());
  await page.screenshot({ path: path.join(OUT, file) });
  await context.close();
}

for (const scheme of ['light', 'dark']) {
  await strip(await phoneShots(scheme), scheme, `phone-${scheme}.png`);
  await desktopShot(scheme, `desktop-${scheme}.png`);
}
await browser.close();
stop();
console.log(`screenshots written to ${OUT}/`);

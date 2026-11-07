// A short tour of the demo for the README and the site: phone-sized, with each tap shown.
//   npm run build && node scripts/video.mjs      (needs ffmpeg; CHROME=/path/to/chrome if elsewhere;
//                                                 PELICAN_DEMO_PORT if 47862 is taken)
// Writes docs/shots/tour.mp4 and docs/shots/tour.gif.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { startDemo } from './demo-server.mjs';

const PORT = Number(process.env.PELICAN_DEMO_PORT ?? 47862);
const BASE = `http://127.0.0.1:${PORT}/`;

const demo = await startDemo({ port: PORT });

const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-video-'));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// A soft dot where each tap lands, so the video says what was touched.
await context.addInitScript(() => {
  addEventListener('pointerdown', (e) => {
    const dot = document.createElement('div');
    dot.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;background:rgba(14,116,144,.28);border:2px solid rgba(14,116,144,.6);pointer-events:none;z-index:99999;transition:transform .45s ease-out,opacity .45s ease-out`;
    document.documentElement.append(dot);
    requestAnimationFrame(() => { dot.style.transform = 'scale(1.5)'; dot.style.opacity = '0'; });
    setTimeout(() => dot.remove(), 500);
  }, true);
  // The demo's note, which the list draws again each time it comes back, is no part of the tour.
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '[data-demo-banner]{display:none!important}';
    document.head.append(style);
  });
});
const page = await context.newPage();
/**
 * Chrome's phone forgets a few seconds in that it has a touch screen (see screenshots.mjs), and a
 * page then lays itself out as a computer's: quotes as chips with ×, keys beside buttons. Looked at
 * every tenth of a second, it is a touch screen again at once.
 */
let touching = true;
const keepTouch = async () => {
  while (touching) {
    const mouse = await page.evaluate(() => !matchMedia('(pointer: coarse)').matches).catch(() => false);
    if (mouse) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const pause = (ms) => page.waitForTimeout(ms);

// Chrome's screencast gives frames at the screen's full resolution (Playwright's recorder does not),
// each with the time it was drawn; ffmpeg later holds each frame until the next.
const frames = [];
const cdp = await context.newCDPSession(page);
const watching = keepTouch();
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
  frames.push({ file, at: metadata.timestamp });
  await writeFile(file, Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
// A finger's tap, not a click: a phone page that reads a mouse lays itself out as a computer's.
const tap = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to tap');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await pause(300);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
await pause(1400);
// An edit waiting for approval, Claude's to-do list a line in the conversation and a bar above the box
await tap(page.getByText('Add a dark theme to the settings page').first());
await pause(1800);
// A passage of Claude's reply, quoted with a note, as in Claude Desktop: selected as a finger's long
// press selects it, then Quote, which waits above the box with Add a note
await page.evaluate(() => {
  const paragraph = [...document.querySelectorAll('[data-quote-what="reply"] p')].find((p) => (p.textContent ?? '').startsWith('The colors are already variables'));
  const node = paragraph?.firstChild;
  if (!node) throw new Error('no paragraph to quote');
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 'The colors are already variables'.length);
  paragraph.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
});
await pause(1100);
await tap(page.getByRole('toolbar', { name: 'Selected text' }).getByRole('button', { name: 'Quote' }));
await pause(900);
await tap(page.getByRole('button', { name: 'Add a note' }));
await pause(400);
await page.keyboard.type('Keep the old names too', { delay: 45 });
await pause(900);
// Allow: the edit lands, the next task starts, and Claude asks a question, answered with a tap
await tap(page.getByRole('button', { name: 'Allow', exact: true }));
await page.getByRole('group', { name: /Claude’s question/ }).waitFor({ timeout: 10_000 });
await pause(1200);
await tap(page.getByRole('button', { name: /^The account/ }));
await pause(500);
await tap(page.getByRole('button', { name: 'Answer' }));
await pause(2600);
// The session's menu is its title, with Changes, Files and Terminal at its top; what changed, with a diff
await tap(page.locator('header h2 button'));
await pause(1500);
await tap(page.getByRole('dialog').getByRole('button', { name: /^Changes/ }));
await pause(1600);
await tap(page.getByText('theme.css').last());
await pause(2000);
await tap(page.getByRole('button', { name: 'Back to the conversation' }));
await pause(600);
await tap(page.getByRole('button', { name: 'Back to sessions' }));
await pause(800);
// A workflow at work in the background, "1 in background": its row above the box leads to its card
await tap(page.getByText('Review the checkout flow before the release').first());
await pause(1600);
await tap(page.getByRole('button', { name: /checkout-fixes/ }).first());
await pause(2400);
await tap(page.getByRole('button', { name: 'Back to sessions' }));
await pause(800);
// A chart Claude drew, rendered right in the conversation
await tap(page.getByText("Chart last week's signups").first());
await pause(2600);
await cdp.send('Page.stopScreencast');
touching = false;
await watching;
const end = Date.now() / 1000;
await context.close();
await browser.close();
await demo.stop();

// Each frame lasts until the next one was drawn; the last one until the tour ended.
const list = ['ffconcat version 1.0'];
frames.forEach((frame, i) => {
  const next = frames[i + 1]?.at ?? Math.max(frame.at + 0.5, end);
  list.push(`file '${frame.file}'`, `duration ${Math.max(0.001, next - frame.at).toFixed(3)}`);
});
list.push(`file '${frames.at(-1).file}'`);
const concat = path.join(dir, 'frames.txt');
await writeFile(concat, `${list.join('\n')}\n`);

const mp4 = 'docs/shots/tour.mp4';
const gif = 'docs/shots/tour.gif';
const ffmpeg = (args) => {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
};
// H.264 for the site, and a small looping GIF for the README.
ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=30,scale=720:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', '-an', mp4]);
ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=12,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', gif]);
console.log(`${frames.length} frames`);
await rm(dir, { recursive: true, force: true });
for (const file of await readdir('docs/shots')) if (file.startsWith('tour')) console.log('wrote docs/shots/' + file);

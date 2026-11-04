// A short tour of the demo for the README and the site: phone-sized, with each tap shown.
//   npm run build && node scripts/video.mjs      (needs ffmpeg; CHROME=/path/to/chrome if elsewhere)
// Writes docs/shots/tour.mp4 and docs/shots/tour.gif.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { startDemo } from './demo-server.mjs';

const PORT = 47862;
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
  addEventListener('DOMContentLoaded', () => document.querySelector('[data-demo-banner]')?.remove());
});
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

// Chrome's screencast gives frames at the screen's full resolution (Playwright's recorder does not),
// each with the time it was drawn; ffmpeg later holds each frame until the next.
const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
  frames.push({ file, at: metadata.timestamp });
  await writeFile(file, Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const tap = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to tap');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => document.querySelector('[data-demo-banner]')?.remove());
await pause(300);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
await pause(1400);
// A chart Claude drew, and the page it wrote, rendered right in the conversation
await tap(page.getByText("Chart last week's signups").first());
await pause(2200);
await tap(page.getByRole('button', { name: /^Write/ }).first());
await pause(2600);
await tap(page.getByRole('button', { name: 'Open full screen' }).last());
await pause(2400);
await tap(page.getByRole('button', { name: 'Close preview' }));
await pause(700);
await tap(page.getByRole('button', { name: 'Back to sessions' }));
await pause(800);
// An edit waiting for approval, and what changed so far
await tap(page.getByText('Add a dark theme to the settings page').first());
await pause(2000);
await tap(page.getByRole('button', { name: 'Changes and files' }));
await pause(1200);
await tap(page.getByRole('dialog').getByText('theme.css').first());
await pause(2000);
await tap(page.getByRole('dialog').getByRole('button', { name: 'Done' }));
await pause(800);
await tap(page.getByRole('button', { name: 'Back to sessions' }));
await pause(800);
// A session Claude Desktop is running, followed live
await tap(page.getByText('Why is the nightly export slow?').first());
await pause(1300);
await tap(page.getByRole('button', { name: /Run/ }).first());
await pause(2200);
await cdp.send('Page.stopScreencast');
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

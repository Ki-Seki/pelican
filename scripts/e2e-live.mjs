// Drives one real turn through the app: a new session on Haiku, a file write that needs approval,
// Allow, Claude's reply. It runs Claude Code for real, in the folder you give (use a throwaway one).
//   node scripts/e2e-live.mjs <pelican link> <folder> <screenshot dir>     (CHROME=/path/to/chrome)
// The link is the one Pelican prints, with its token (`pelican token` prints it again).
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright-core';

const [base, folder, out] = process.argv.slice(2);
if (!base || !folder || !out) {
  console.error('usage: node scripts/e2e-live.mjs <pelican url> <folder> <screenshot dir>');
  process.exit(2);
}
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => page.screenshot({ path: `${out}/${name}.png` });

// The link signs the browser in; then the new-session page in the folder.
const link = new URL(base);
await page.goto(link.href, { waitUntil: 'networkidle' });
link.search = '';
await page.goto(`${link.href}?new&cwd=${encodeURIComponent(folder)}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Model, effort and speed' }).click();
await page.getByRole('dialog').getByText('Haiku 5.5', { exact: true }).click();
// The model sheet stays open for effort and speed; the mode sheet closes on a choice.
const closeSheet = async () => {
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
};
await closeSheet();
await page.getByRole('button', { name: 'Permission mode' }).click();
await page.getByRole('dialog').getByText('Manual', { exact: true }).click();
await closeSheet();
await page.locator('textarea').fill('Create a file named hello.txt containing the single word hi. Then reply with one short sentence.');
await shot('1-new');
await page.getByRole('button', { name: 'Send' }).click();
const t0 = Date.now();
await page.waitForURL(/\?s=/, { timeout: 30_000 });
console.log('session url', page.url());
await page.getByRole('button', { name: 'Allow', exact: true }).waitFor({ timeout: 90_000 });
console.log('approval card after', Date.now() - t0, 'ms');
await shot('2-approval');
await page.getByRole('button', { name: 'Allow', exact: true }).click();
// The turn is over when the Stop button goes and stays gone. Note every change on the way:
// Stop should give way to Send once, at the end.
const stop = page.getByRole('button', { name: 'Stop' });
const changes = [];
for (let quiet = 0; quiet < 8; ) {
  await page.waitForTimeout(100);
  const busy = (await stop.count()) > 0;
  if (changes.at(-1)?.busy !== busy) changes.push({ at: Date.now() - t0, busy });
  quiet = busy ? 0 : quiet + 1;
  if (Date.now() - t0 > 120_000) throw new Error('The turn did not finish in two minutes');
}
console.log('turn done after', Date.now() - t0, 'ms; Stop/Send changes:', JSON.stringify(changes));
await shot('3-done');
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();

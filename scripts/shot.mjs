// Screenshots of the running app for visual review.
//   node scripts/shot.mjs <url> <out.png> [phone|desktop] [dark] [--click "text"]... [--type "text"] [--wait ms]
import { chromium } from 'playwright-core';

const [url, out, device = 'phone', ...rest] = process.argv.slice(2);
const dark = rest.includes('dark');
const actions = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === '--click') actions.push({ click: rest[++i] });
  else if (rest[i] === '--type') actions.push({ type: rest[++i] });
  else if (rest[i] === '--wait') actions.push({ wait: Number(rest[++i]) });
  else if (rest[i] === '--scroll-top') actions.push({ scrollTop: true });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext(
  device === 'phone'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' },
);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
for (const action of actions) {
  if (action.click) await page.getByText(action.click, { exact: false }).first().click();
  if (action.type) await page.keyboard.type(action.type);
  if (action.wait) await page.waitForTimeout(action.wait);
  if (action.scrollTop) await page.evaluate(() => document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = 0; }));
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out });
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();

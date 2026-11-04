// Sends one follow-up in an existing session and waits for the turn to finish.
//   node scripts/e2e-followup.mjs <base url> <session id> <message> <out.png>
import { chromium } from 'playwright-core';

const [base, id, message, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?s=${id}`, { waitUntil: 'networkidle' });
await page.locator('textarea').fill(message);
const t0 = Date.now();
await page.getByRole('button', { name: 'Send' }).click();
await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 20_000 }).catch(() => console.log('never saw Stop'));
await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(1800);
console.log('turn done after', Date.now() - t0, 'ms; still sending:', await page.getByText('Sending…').count());
await page.screenshot({ path: out });
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();

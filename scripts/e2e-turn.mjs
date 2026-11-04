// Drives one real turn through the UI: new session → Haiku → a Write that needs approval → Allow → reply.
//   node scripts/e2e-turn.mjs <base url> <folder> <out dir>
import { chromium } from 'playwright-core';

const [base, folder, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => page.screenshot({ path: `${out}/${name}.png` });

await page.goto(`${base}?new&cwd=${encodeURIComponent(folder)}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Model' }).click();
await page.getByText('Haiku 5.5').click();
await page.getByRole('button', { name: 'Permission mode' }).click();
await page.getByText('Ask before acting').click();
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
await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 90_000 });
await page.waitForTimeout(1500);
console.log('turn done after', Date.now() - t0, 'ms');
await shot('3-done');
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();

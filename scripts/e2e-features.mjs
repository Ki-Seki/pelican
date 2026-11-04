// Exercises questions, plan approval, stop and image attachments through the UI with Haiku.
//   node scripts/e2e-features.mjs <base url> <folder> <out dir> <image>
import { chromium } from 'playwright-core';

const [base, folder, out, image] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const idle = () => page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 120_000 });
const lastReply = async () => (await page.locator('.prose-chat').last().innerText()).trim();

async function fresh(mode) {
  await page.goto(`${base}?new&cwd=${encodeURIComponent(folder)}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Model' }).click();
  await page.getByRole('dialog').getByText('Haiku 5.5').click();
  await page.getByRole('button', { name: 'Permission mode' }).click();
  await page.getByRole('dialog').getByText(mode).click();
}
async function say(text) {
  await page.locator('textarea').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

// 1. A question from Claude.
await fresh('Ask before acting');
await say('Use the AskUserQuestion tool to ask me one question: do I prefer red or blue (options: Red, Blue). After I answer, reply with only my choice.');
await page.getByRole('button', { name: 'Answer', exact: true }).waitFor({ timeout: 90_000 });
await shot('q1-question');
await page.getByRole('button', { name: /^Blue/ }).click();
await page.getByRole('button', { name: 'Answer', exact: true }).click();
await idle();
await page.waitForTimeout(1200);
console.log('question → reply:', JSON.stringify(await lastReply()));
await shot('q2-answered');

// 2. Plan first, then approve.
await fresh('Plan first');
await say('Plan how to append a line "bye" to hello.txt in this folder. The plan is two bullet points. Then present it.');
await page.getByRole('button', { name: /Approve · accept edits/ }).waitFor({ timeout: 120_000 });
await shot('p1-plan');
await page.getByRole('button', { name: /Approve · accept edits/ }).click();
await idle();
await page.waitForTimeout(1200);
await shot('p2-done');
console.log('plan approved → reply:', JSON.stringify((await lastReply()).slice(0, 120)));

// 3. Stop a long answer.
await fresh('Ask before acting');
await say('Count from 1 to 400, one number per line, no other text.');
await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Stop' }).click();
const t0 = Date.now();
await idle();
console.log('stopped after', Date.now() - t0, 'ms');
await page.waitForTimeout(1000);
await shot('s1-stopped');

// 4. An image attachment.
await fresh('Ask before acting');
await page.locator('input[type=file]').setInputFiles(image);
await page.waitForTimeout(1500);
await shot('i1-attached');
await say('What colour is this image? Reply with one word.');
await idle();
await page.waitForTimeout(1500);
console.log('image → reply:', JSON.stringify(await lastReply()));
await shot('i2-reply');

if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();

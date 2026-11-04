import { chromium } from 'playwright-core';
const [html, out, w, h] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
await page.goto(`file://${html}`);
await page.waitForTimeout(400);
await page.screenshot({ path: out, fullPage: true });
await browser.close();

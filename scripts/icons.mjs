// Draws every icon from one glyph: the favicon and logo (SVG), the PWA icons, the iOS
// home-screen icon and the monochrome notification badge (PNG, through headless Chrome).
//   node scripts/icons.mjs        (CHROME=/path/to/chrome if it is not in the usual place)
import { writeFile } from 'node:fs/promises';

import { chromium } from 'playwright-core';

const COLOR = '#0e7490';
const GLYPH = (stroke = '#fff') =>
  `<g transform="translate(-0.5 -0.2)" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`
  + '<path d="M8.7 19.2C6.4 17.1 6.6 14.9 7.4 13c.7-1.7-.9-2.9-.7-4.7.2-2.1 2.1-3.2 4-2.7l8.9 3"/>'
  + '<path d="M19.6 8.6c-2.3 3.9-6.3 5.7-9 3.4"/>'
  + `<circle cx="9.15" cy="8.35" r="1.05" fill="${stroke}" stroke="none"/></g>`;

/** The glyph on a background; `scale` shrinks it toward the middle (maskable icons keep a safe zone). */
const svg = ({ rounded = true, scale = 1, background = COLOR, stroke = '#fff' } = {}) => {
  const inset = (24 - 24 * scale) / 2;
  const bg = background ? `<rect width="24" height="24" ${rounded ? 'rx="7"' : ''} fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24">${bg}<g transform="translate(${inset} ${inset}) scale(${scale})">${GLYPH(stroke)}</g></svg>\n`;
};

await writeFile('public/icon.svg', svg());
await writeFile('docs/logo.svg', svg());

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
async function png(file, size, markup, transparent = false) {
  // A fresh page each time: a reused one kept the previous icon's opaque background.
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const body = markup.replace('width="64" height="64"', `width="${size}" height="${size}"`);
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${body}`);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}
await png('public/icon-192.png', 192, svg(), true);
await png('public/icon-512.png', 512, svg(), true);
await png('public/icon-maskable-512.png', 512, svg({ rounded: false, scale: 0.72 }));
await png('public/apple-touch-icon.png', 180, svg({ rounded: false, scale: 0.8 }));
await png('public/badge-96.png', 96, svg({ background: '', stroke: '#fff', scale: 1.05 }), true);
await browser.close();
console.log('icons written');

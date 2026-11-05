// Opens Pelican in a real browser and fails on any page error, console error, failed request or
// HTTP error: the list, its sheets, a new session in another folder, and every session with its
// sheets, on a phone and wide, light and dark. Runs in CI after the build, and before the site is
// published.
//   node scripts/smoke.mjs              the built app, through `pelican --demo`
//   node scripts/smoke.mjs <site dir>   the site from scripts/site.mjs: its pages, then its live demo
// CHROME=/path/to/chrome if it is not in the usual place; PELICAN_DEMO_PORT if 47863 is taken.
import { readdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { MARK, startDemo } from './demo-server.mjs';

const CHROME = process.env.CHROME
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 1280, height: 800 } },
};
const LIST_BUTTONS = ['Settings', 'New session', 'List options'];
const SESSION_BUTTONS = ['Session menu', 'Model, effort and speed', 'Permission mode', 'Changes and files'];

const problems = [];
const notes = [];

/** GitHub Pages, near enough: files under one folder, a folder's index.html, nothing else. */
async function serveFolder(root) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4',
    '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2',
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = path.join(root, decodeURIComponent(url.pathname));
    try {
      if (!file.startsWith(root)) throw new Error('outside');
      const info = await stat(file);
      if (info.isDirectory() && !url.pathname.endsWith('/')) {
        response.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      const target = info.isDirectory() ? path.join(file, 'index.html') : file;
      const body = await readFile(target);
      response.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}/`, stop: () => server.close() };
}

/** Every page error, console error, failed request and HTTP error, with where it happened. */
function watch(page, where) {
  page.on('pageerror', (error) => problems.push(`${where()}: page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${where()}: console error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    // Leaving a page cancels what it was still loading; that is not a failure.
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`${where()}: request failed: ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${where()}: HTTP ${response.status()}: ${response.url()}`);
  });
}

async function press(page, label, where) {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  if (!(await button.count())) {
    notes.push(`${where}: no "${label}" button`);
    return;
  }
  await button.click();
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

/**
 * + and then a folder of the new session's own, through its folder sheet: Browse folders…, a
 * folder there, Start here. The empty chat then asks about a folder no session is in.
 */
async function startElsewhere(page, where) {
  const sheet = () => page.getByRole('dialog').last();
  const steps = [
    ['New session', () => page.getByRole('button', { name: 'New session', exact: true }).first()],
    ['Folder', () => page.locator('button[aria-label^="Folder: "]').first()],
    ['Browse folders…', () => sheet().getByRole('button', { name: 'Browse folders…', exact: true })],
    ['code', () => sheet().getByRole('button', { name: 'code', exact: true })],
    ['Start here', () => sheet().getByRole('button', { name: 'Start here', exact: true })],
  ];
  for (const [label, find] of steps) {
    const button = find();
    // The chat loads on demand, and a folder's listing arrives after the tap that asks for it.
    if (!(await button.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
      notes.push(`${where}: no "${label}" button`);
      return;
    }
    await button.click();
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  if (!(await page.locator('button[aria-label="Folder: ~/code"]').count())) problems.push(`${where}: the new session does not start in ~/code`);
}

/** Changes and files, open on a step (beside the conversation it opens from its button; the address names only the step). */
async function openWorkspace(page, url) {
  const view = page.locator('[role="region"][aria-label="Changes and files"], aside[aria-label="Changes and files"]');
  await page.goto(url, { waitUntil: 'networkidle' });
  if (!(await view.count())) await page.getByRole('button', { name: 'Changes and files', exact: true }).first().click();
  return (await view.waitFor({ timeout: 5000 }).then(() => true, () => false)) ? view : undefined;
}

/**
 * Down the Files tab to the first file with something in it that shows as numbered lines (pages
 * and Markdown open as they look), and open it.
 */
async function openSourceFile(page, view) {
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(await view.locator('button:has(> span.font-mono)').first().waitFor({ timeout: 5000 }).then(() => true, () => false))) return undefined;
    const entries = await view.locator('button:has(> span.font-mono)').evaluateAll((rows) => rows.map((row) => ({
      name: row.querySelector('span.font-mono')?.textContent ?? '',
      size: row.querySelector('span.font-mono + span')?.textContent ?? '',
      folder: Boolean(row.querySelector('svg.lucide-folder')),
    })));
    const code = entries.find((e) => !e.folder && e.size && e.size !== '0 B' && /\.(css|scss|tsx?|jsx?|py|go|rs|json|ya?ml|toml|sh|sql|txt)$/.test(e.name));
    if (code) {
      await view.locator('button > span.font-mono').getByText(code.name, { exact: true }).first().click();
      const shown = await page.locator('[data-line="2"]').waitFor({ timeout: 5000 }).then(() => true, () => false);
      return shown ? code.name : undefined;
    }
    const folder = entries.find((e) => e.folder);
    if (!folder) return undefined;
    await view.locator('button > span.font-mono').getByText(folder.name, { exact: true }).first().click();
    await view.locator('nav[aria-label="Folder"] [aria-current="location"]').getByText(folder.name, { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
  }
  return undefined;
}

/** Lines of the open file selected, as a drag over them selects them. */
function selectLines(page, from, to) {
  return page.evaluate(([a, b]) => {
    const [first, last] = [a, b].map((n) => document.querySelector(`[data-line="${n}"]`));
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, [from, to]);
}

/**
 * Changes and files, walked as someone reading the session does: Files, a file, two of its lines
 * selected and quoted into the message; a search of the files' text; Show, a turn, and the diff of
 * a file it changed. The page's watch catches what goes wrong on the way; this, what never shows.
 */
async function walkWorkspace(page, base, session, where, step) {
  const url = `${base}?s=${encodeURIComponent(session.id)}`;
  // The site's demo has no computer to search with, and says so.
  const live = !base.endsWith('/demo/');
  const missing = (what) => problems.push(`${where}, session ${session.id}: ${what}`);

  step('Files, a file and Quote');
  let view = await openWorkspace(page, `${url}&w=files`);
  if (!view) return missing('Changes and files does not open');
  const file = await openSourceFile(page, view);
  if (!file) return missing('Files opens no file as its lines');
  const word = (await page.locator('[data-line="1"]').textContent())?.match(/[A-Za-z_]{3,}/)?.[0] ?? 'the';
  await selectLines(page, 1, 2);
  const quote = page.getByRole('button', { name: 'Quote', exact: true });
  if (!(await quote.waitFor({ timeout: 3000 }).then(() => true, () => false))) return missing(`selecting lines of ${file} offers no Quote`);
  await quote.click();
  if (!(await page.locator('button[aria-label^="Remove the quote"]').first().waitFor({ timeout: 3000 }).then(() => true, () => false))) missing(`Quote on ${file} puts no quote above the message box`);

  step('a text search');
  view = await openWorkspace(page, `${url}&w=files`);
  if (!view) return missing('Changes and files does not open again');
  await view.getByRole('searchbox', { name: 'Search files' }).fill(word);
  await view.getByRole('button', { name: /^Search in files for/ }).click();
  const answered = view.locator('mark').or(view.getByText(/^No file holds|This is a demo/)).first();
  if (!(await answered.waitFor({ timeout: 8000 }).then(() => true, () => false))) missing(`searching the files for "${word}" shows nothing`);
  else if (live && !(await view.locator('mark').count())) missing(`searching the files for "${word}" does not find it in ${file}`);

  step('Show, a turn and its diff');
  view = await openWorkspace(page, `${url}&w=changes`);
  if (!view) return missing('Changes does not open');
  const show = view.getByRole('button', { name: /^Show:/ });
  if (!(await show.waitFor({ timeout: 5000 }).then(() => true, () => false))) return missing('Changes has no Show');
  await show.click();
  const turn = page.getByRole('dialog', { name: 'Show' }).getByRole('button', { name: /^T\d+ · / }).first();
  if (!(await turn.waitFor({ timeout: 5000 }).then(() => true, () => false))) return missing('Show offers no turn');
  await turn.click();
  const changed = view.locator('button:has(> span[title])').first();
  if (!(await changed.waitFor({ timeout: 5000 }).then(() => true, () => false))) return missing('the turn lists no file');
  await changed.click();
  if (!(await page.locator('[role="group"][aria-label^="Changes to "]').waitFor({ timeout: 5000 }).then(() => true, () => false))) missing('a file the turn changed shows no diff');
  await page.waitForLoadState('networkidle');
}

/** The name the site build gives a saved answer (scripts/site.mjs, src/web/lib/static-demo.ts). */
function requestKey(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Where Changes and files is walked through: the newest session with a folder where a turn
 * changed files (`answer` asks the demo for a session's changes, or reads the answer the site
 * saved), else the newest with a folder. The newest may have no such turn: in the demo's workflow
 * session, the edits are its agents'.
 */
async function walkable(sessions, answer) {
  const folders = sessions.filter((s) => !s.sideChatOf && s.cwd);
  for (const session of folders) {
    const changes = await answer(`sessions/${encodeURIComponent(session.id)}/changes`).catch(() => undefined);
    if (changes?.turns?.some((turn) => turn.files?.length > 0)) return session;
  }
  return folders[0];
}

/**
 * The list, its sheets, a new session in another folder, and every session with its sheets; then
 * Changes and files, walked through in `walked`.
 */
async function driveApp(browser, base, sessions, walked) {
  // The list folds side chats away under their session.
  const titles = [...new Set(sessions.filter((s) => !s.sideChatOf).map((s) => s.title).filter(Boolean))].slice(0, 3);
  // Sessions older than a day (the usage page's history) are all of one plain kind: the first size
  // and theme open every session, the others today's, which hold all a conversation can show.
  const today = sessions.filter((s) => Date.now() - (s.lastActivity ?? 0) < 24 * 60 * 60_000);
  let all = true;
  for (const [size, options] of Object.entries(SIZES)) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      const page = await context.newPage();
      let at = 'the list';
      watch(page, () => `app, ${size}, ${scheme}, ${at}`);
      await page.goto(base, { waitUntil: 'networkidle' });
      for (const title of titles) {
        if (!(await page.getByText(title, { exact: true }).first().isVisible())) problems.push(`app, ${size}, ${scheme}: the list does not show "${title}"`);
      }
      for (const label of LIST_BUTTONS) {
        await press(page, label, `app, ${size}`);
        await page.goto(base, { waitUntil: 'networkidle' });
      }
      at = 'a new session in another folder';
      await startElsewhere(page, `app, ${size}`);
      for (const session of all ? sessions : today) {
        at = `session ${session.id}`;
        await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        if (session.title && !(await page.getByText(session.title).first().isVisible())) problems.push(`app, ${size}, ${scheme}: session ${session.id} does not show its title`);
        for (const label of SESSION_BUTTONS) await press(page, label, `app, ${size}, session ${session.id}`);
      }
      if (walked) await walkWorkspace(page, base, walked, `app, ${size}, ${scheme}`, (what) => { at = `session ${walked.id}, ${what}`; });
      all = false;
      await context.close();
    }
  }
}

/**
 * On screens wide enough for Changes and files to sit beside the conversation, from the narrowest
 * such width, where the session list folds away, to where list, conversation and pane all fit:
 * the pane stays inside the window (a conversation column that grew to fit its content once pushed
 * it out of view), nothing in it is cut off at its right edge, and the conversation keeps room. In
 * a file, a selection's Quote and Copy sit at the pane's foot, under what scrolls.
 */
async function checkDocked(browser, base, sessions) {
  for (const width of [1024, 1280, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    await context.addInitScript(() => {
      // Every frame runs this, sandboxed previews too, which have no storage.
      try {
        const prefs = JSON.parse(localStorage.getItem('pelican:prefs') || '{}');
        localStorage.setItem('pelican:prefs', JSON.stringify({ ...prefs, workspacePane: true }));
      } catch {
        // A frame without storage.
      }
    });
    const page = await context.newPage();
    let at = '';
    watch(page, () => `app, docked at ${width}px, ${at}`);
    for (const session of sessions) {
      at = `session ${session.id}`;
      await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const found = await page.evaluate(() => {
        const pane = document.querySelector('aside[aria-label="Changes and files"]');
        if (!pane) return [];
        // A line far wider than the column, cut short as long tool lines are: it must not widen it.
        const column = document.querySelector('main .max-w-3xl');
        const probe = document.createElement('div');
        probe.className = 'truncate';
        probe.textContent = 'A very long line '.repeat(80);
        column?.append(probe);
        // A file name far longer than its row, in the pane and in a step: it ends in an ellipsis,
        // and what follows it on the row (its counts) stays in view.
        const name = 'a-very-long-component-file-name-that-keeps-going-and-going.stories.tsx';
        for (const span of document.querySelectorAll('aside button span.flex.min-w-0.items-baseline > span:first-child, main span.flex.min-w-0.items-baseline > span:first-child')) span.textContent = name;
        const out = [];
        const r = pane.getBoundingClientRect();
        if (r.right > innerWidth + 1) out.push(`Changes and files ends ${Math.round(r.right - innerWidth)}px past the window`);
        for (const row of document.querySelectorAll('aside button, main button')) {
          const end = row.getBoundingClientRect().right;
          if ([...row.children].some((child) => child.getBoundingClientRect().right > end + 1)) {
            out.push(`a long name pushes the end of "${row.textContent.slice(0, 40)}" out of view`);
            break;
          }
        }
        // What it shows wider than itself would be cut at its edge (it scrolls only up and down).
        for (const el of pane.querySelectorAll('*')) {
          const box = el.getBoundingClientRect();
          if (box.width > 0 && box.right > r.right + 1 && !el.closest('.overflow-x-auto, .truncate, .sr-only')) {
            out.push(`a ${el.tagName.toLowerCase()} in Changes and files ends ${Math.round(box.right - r.right)}px past its edge`);
            break;
          }
        }
        const conversation = document.querySelector('main')?.getBoundingClientRect();
        if (conversation && conversation.width - r.width < 320) out.push(`the conversation is ${Math.round(conversation.width - r.width)}px wide beside the pane`);
        return out;
      });
      problems.push(...found.map((problem) => `app, docked at ${width}px, session ${session.id}: ${problem}`));
    }
    const reading = sessions.find((s) => !s.sideChatOf && s.cwd);
    if (reading) {
      at = `session ${reading.id}, a file's selection`;
      const view = await openWorkspace(page, `${base}?s=${encodeURIComponent(reading.id)}&w=files`);
      const file = view && await openSourceFile(page, view);
      if (!file) {
        problems.push(`app, docked at ${width}px, session ${reading.id}: Files opens no file as its lines`);
      } else {
        await selectLines(page, 1, 2);
        await page.getByRole('button', { name: 'Quote', exact: true }).waitFor({ timeout: 3000 }).catch(() => {});
        const out = await page.evaluate(() => {
          const pane = document.querySelector('aside[aria-label="Changes and files"]');
          const bar = [...pane.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Quote')?.parentElement;
          if (!bar) return 'selecting lines of a file offers no Quote';
          const scroller = pane.querySelector('.overflow-y-auto');
          const { bottom, top } = bar.getBoundingClientRect();
          if (scroller.contains(bar) || Math.abs(scroller.getBoundingClientRect().bottom - top) > 1) return 'a file scrolls under its Quote and Copy';
          return Math.abs(pane.getBoundingClientRect().bottom - bottom) > 1 ? `Quote and Copy end ${Math.round(pane.getBoundingClientRect().bottom - bottom)}px above the pane's foot` : '';
        });
        if (out) problems.push(`app, docked at ${width}px, session ${reading.id}, ${file}: ${out}`);
      }
    }
    await context.close();
  }
}

/**
 * The side chat, at the narrowest width it sits beside the conversation at, where the session list
 * folds away for it: it opens with Cmd/Ctrl+;, stays inside the window when the conversation holds
 * a long line, leaves the conversation room, and answers a question (the demo acts the answer out).
 */
async function checkSideChat(browser, base, sessions) {
  const session = sessions.find((s) => !s.sideChatOf);
  if (!session) return;
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  watch(page, () => 'app, side chat');
  await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.keyboard.press('ControlOrMeta+;');
  const pane = page.getByRole('complementary', { name: 'Side chat' });
  if (!(await pane.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
    problems.push('app, side chat: does not open with Cmd/Ctrl+;');
    await context.close();
    return;
  }
  const found = await page.evaluate(() => {
    const out = [];
    const side = document.querySelector('aside[aria-label="Side chat"]');
    const column = document.querySelector('main .max-w-3xl');
    const probe = document.createElement('div');
    probe.className = 'truncate';
    probe.textContent = 'A very long line '.repeat(80);
    column?.append(probe);
    const r = side.getBoundingClientRect();
    if (r.right > innerWidth + 1) out.push(`ends ${Math.round(r.right - innerWidth)}px past the window`);
    const conversation = document.querySelector('main')?.getBoundingClientRect();
    if (conversation && conversation.width - r.width < 320) out.push(`the conversation is ${Math.round(conversation.width - r.width)}px wide beside it`);
    return out;
  });
  problems.push(...found.map((problem) => `app, side chat: ${problem}`));
  const question = 'Why CSS variables, and not a context?';
  const box = pane.getByRole('textbox', { name: 'Side question' });
  await box.fill(question);
  await box.press('Enter');
  if (!(await pane.getByText(/answers here from the session so far/).first().waitFor({ timeout: 8000 }).then(() => true, () => false))) {
    problems.push('app, side chat: a question gets no answer');
  } else if (!(await pane.getByText(question).count())) {
    problems.push('app, side chat: the question does not show above its answer');
  }
  await context.close();
}

/**
 * Settings > Usage and activity, on a phone and wide, light and dark, in each range: it fills in
 * from the demo's transcripts, and nothing on it ends past the window.
 */
async function checkUsage(browser, base) {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      const page = await context.newPage();
      watch(page, () => `app, usage, ${size}, ${scheme}`);
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      const row = page.getByRole('button', { name: /^Usage and activity/ }).first();
      if (!(await row.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
        problems.push(`app, usage, ${size}: Settings has no Usage and activity`);
        await context.close();
        continue;
      }
      await row.click();
      const sheet = page.getByRole('dialog', { name: 'Usage and activity' });
      for (const range of ['7 days', '30 days', 'All']) {
        const pick = sheet.getByRole('radio', { name: range, exact: true }).or(sheet.getByRole('button', { name: range, exact: true })).first();
        if (await pick.count()) await pick.click();
        else notes.push(`app, usage, ${size}: no "${range}" range`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        const found = await page.evaluate(() => {
          const out = [];
          const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
          if (!dialog || !/\d/.test(dialog.textContent ?? '')) out.push('shows no figures');
          for (const el of dialog?.querySelectorAll('*') ?? []) {
            const box = el.getBoundingClientRect();
            if (box.width > 0 && box.right > innerWidth + 1 && !el.closest('.overflow-x-auto, .sr-only')) {
              out.push(`a ${el.tagName.toLowerCase()} ends ${Math.round(box.right - innerWidth)}px past the window`);
              break;
            }
          }
          return out;
        });
        problems.push(...found.map((problem) => `app, usage, ${size}, ${scheme}, ${range}: ${problem}`));
      }
      await context.close();
    }
  }
}

/** The site's own pages: the pictures fit their phones, the demo frame lays out as a phone does. */
async function checkSite(browser, base) {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      const page = await context.newPage();
      let at = '';
      watch(page, () => `site, ${size}, ${scheme}, ${at}`);
      for (const name of ['index.html', 'docs.html']) {
        at = name;
        await page.goto(base + (name === 'index.html' ? '' : name), { waitUntil: 'networkidle' });
        const found = await page.evaluate(() => {
          const out = [];
          const box = (el) => el.getBoundingClientRect();
          for (const img of document.querySelectorAll('.phone img')) {
            const a = box(img);
            const b = box(img.closest('.screen'));
            if (a.width === 0) continue;
            if (a.left < b.left - 1 || a.right > b.right + 1 || a.top < b.top - 1 || a.bottom > b.bottom + 1) out.push(`${img.getAttribute('src')} overflows its phone`);
          }
          const frame = document.querySelector('.device iframe');
          if (frame && box(frame).width > 0) {
            const a = box(frame);
            const b = box(frame.closest('.screen'));
            if (Math.abs(a.bottom - b.bottom) > 2 || Math.abs(a.width - b.width) > 2) out.push('the demo frame does not fill its phone');
          }
          for (const link of document.querySelectorAll('a[href^="#"]')) {
            const id = decodeURIComponent(link.getAttribute('href').slice(1));
            if (id && !document.getElementById(id)) out.push(`the link to #${id} goes nowhere`);
          }
          const ctas = document.querySelector('.hero .ctas');
          if (ctas && innerWidth <= 640 && box(ctas).bottom > innerHeight) out.push('the buttons are below the first screen');
          return out;
        });
        problems.push(...found.map((problem) => `site, ${size}, ${scheme}, ${name}: ${problem}`));
        const frame = page.frames().find((f) => f.url().includes('/demo/'));
        if (frame && await page.locator('.device iframe').isVisible()) {
          await frame.waitForLoadState('networkidle');
          const width = await frame.evaluate(() => innerWidth);
          if (width !== 390) problems.push(`site, ${size}, ${scheme}, ${name}: the demo frame lays out at ${width}px, not 390px`);
        }
      }
      await context.close();
    }
  }
}

/** What the saved demo answers say the sessions are. */
async function savedSessions(site) {
  const data = path.join(site, 'demo', 'data');
  for (const file of await readdir(data)) {
    const body = JSON.parse(await readFile(path.join(data, file), 'utf8'));
    if (Array.isArray(body?.sessions)) return body.sessions;
  }
  throw new Error(`${data} has no saved list of sessions`);
}

const site = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const started = Date.now();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let stop = async () => {};
try {
  if (site) {
    const server = await serveFolder(site);
    stop = async () => server.stop();
    await checkSite(browser, server.base);
    const sessions = await savedSessions(site);
    const saved = (request) => readFile(path.join(site, 'demo', 'data', `${requestKey(request)}.json`), 'utf8').then(JSON.parse);
    await driveApp(browser, `${server.base}demo/`, sessions, await walkable(sessions, saved));
    await checkUsage(browser, `${server.base}demo/`);
  } else {
    const demo = await startDemo({ port: Number(process.env.PELICAN_DEMO_PORT ?? 47863), name: 'smoke' });
    stop = demo.stop;
    const { sessions } = await (await fetch(`${demo.base}api/sessions`, { headers: MARK })).json();
    if (!sessions?.length) problems.push('the demo has no sessions');
    const asked = (request) => fetch(`${demo.base}api/${request}`, { headers: MARK }).then((r) => r.json());
    await driveApp(browser, demo.base, sessions ?? [], await walkable(sessions ?? [], asked));
    await checkDocked(browser, demo.base, sessions ?? []);
    await checkSideChat(browser, demo.base, sessions ?? []);
    await checkUsage(browser, demo.base);
  }
} finally {
  await browser.close();
  await stop();
}

for (const note of [...new Set(notes)]) console.log(`note: ${note}`);
const unique = [...new Set(problems)];
console.log(`${site ? `site ${site}` : 'app'}: ${unique.length} problem${unique.length === 1 ? '' : 's'} in ${Math.round((Date.now() - started) / 1000)} s`);
for (const problem of unique) console.log(`  ${problem}`);
process.exit(unique.length ? 1 : 0);

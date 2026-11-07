// Opens Pelican in a real browser and fails on any page error, console error, failed request or
// HTTP error: the list, its sheets, a new session in another folder, and every session with its
// sheets and the files Claude sent there, on a phone and wide, light and dark; and the ways in to
// every action (menus, swipes, long presses, right-clicks, ⌘K, the sidebar, Back on a phone). Runs
// in CI after the build, and before the site is published.
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
// The message box's own; the title's menu and the panes' buttons are pressed by pressSession.
const SESSION_BUTTONS = ['Add', 'Model, effort and speed', 'Permission mode'];
/** The conversation's header (the list's has no h2), and its title, which opens the session's menu. */
const CHAT_HEADER = 'header:has(> h2)';
const TITLE = `${CHAT_HEADER} h2 > button`;

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

/** Whether something shows within a while. */
const shows = (locator, timeout = 3000) => locator.waitFor({ timeout }).then(() => true, () => false);

/**
 * The menu or sheet of actions on top, once it opens: its name, its entries as they read (with
 * their keys and details), and all its words. Undefined if none opens.
 */
async function openMenu(page, timeout = 3000) {
  const found = await page.waitForFunction(() => {
    const dialog = [...document.querySelectorAll('dialog[open]:not([data-closing])')].at(-1);
    const menu = dialog?.querySelector('[role="menu"]');
    if (!menu) return false;
    return {
      name: menu.getAttribute('aria-label') ?? '',
      entries: [...menu.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent.trim()),
      text: dialog.textContent ?? '',
    };
  }, undefined, { timeout, polling: 100 }).catch(() => undefined);
  return found ? found.jsonValue() : undefined;
}

/** Whether every sheet and menu has gone, once it had time to. */
const allClosed = (page, timeout = 3000) => page.waitForFunction(() => !document.querySelector('dialog[open]'), undefined, { timeout, polling: 100 }).then(() => true, () => false);

/** The entries a menu should list and does not, each by its first words (a string) or a pattern. */
const lacks = (menu, names) => names.filter((name) => !menu.entries.some((entry) => (typeof name === 'string' ? entry.startsWith(name) : name.test(entry))));

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

/** The header's button for each of the view's tabs on a computer; a phone's header has one for all three. */
const PANE_BUTTONS = { changes: 'Changes', files: 'Files', terminal: 'Terminal' };

/**
 * Changes and files, open on a step: beside the conversation, from the header's button for the
 * step's tab (the address names only the step); on a phone the address opens it, else the
 * header's one button does.
 */
async function openWorkspace(page, url) {
  const view = page.locator('[role="region"][aria-label="Changes and files"], aside[aria-label="Changes and files"]');
  await page.goto(url, { waitUntil: 'networkidle' });
  if (!(await view.count())) {
    const header = page.locator(CHAT_HEADER);
    const tab = PANE_BUTTONS[new URL(url).searchParams.get('w')] ?? 'Changes';
    await header.getByRole('button', { name: tab, exact: true }).or(header.getByRole('button', { name: /^Changes, / })).first().click();
  }
  return (await view.waitFor({ timeout: 5000 }).then(() => true, () => false)) ? view : undefined;
}

/**
 * A session's own buttons, each opened and closed again: the title's menu, the message box's,
 * and Changes and files (beside the conversation its Changes button shows the pane and hides it
 * again; on a phone the header's one button opens the view over it).
 */
async function pressSession(page, wide, where) {
  const title = page.locator(TITLE);
  if (await title.count()) {
    await title.click();
    if (!(await openMenu(page))) problems.push(`${where}: the title opens no menu`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  } else notes.push(`${where}: no title`);
  for (const label of SESSION_BUTTONS) await press(page, label, where);
  const header = page.locator(CHAT_HEADER);
  if (wide) {
    const changes = header.getByRole('button', { name: 'Changes', exact: true });
    if (!(await changes.count())) return;
    const pane = page.locator('aside[aria-label="Changes and files"]');
    // Open since a session before (it stays open from one to the next): the pressed button hides it.
    if (await pane.isVisible()) {
      const pressed = header.locator('button[aria-pressed="true"]');
      if (!(await pressed.count())) problems.push(`${where}: Changes and files shows, and none of the header's buttons is pressed`);
      else await pressed.first().click();
      await pane.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
    await changes.click();
    if (!(await shows(pane))) problems.push(`${where}: Changes shows no pane`);
    else if (await changes.getAttribute('aria-pressed') !== 'true') problems.push(`${where}: Changes is not pressed while its pane shows`);
    await changes.click();
    if (!(await pane.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false))) problems.push(`${where}: Changes pressed again leaves its pane`);
  } else {
    const button = header.getByRole('button', { name: /^Changes, / });
    if (await button.count()) await press(page, (await button.getAttribute('aria-label')) ?? '', where);
  }
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

/** The terminal's code, xterm.js with it: a part of its own that only the Terminal tab loads. */
const TERMINAL_CODE = /\/WorkspaceTerminal-[\w-]+\.js$/;

/**
 * Changes and files, walked as someone reading the session does: Files, a file, two of its lines
 * selected and quoted into the message; a search of the files' text; Show, a turn, and the diff of
 * a file it changed (the session is one where a turn changed files: see walkable); then the
 * Terminal tab, which no step before it has loaded, and where both demos say that nothing runs
 * (Ctrl+` opens it beside the conversation). The page's watch catches what goes wrong on the way;
 * this, what never shows. `requested`: every address the page has asked for so far.
 */
async function walkWorkspace(page, base, session, where, step, requested) {
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
  // It waits above the message box: a chip, or on a phone the card of the quote just taken.
  const waits = page.locator('ul[aria-label="With your next message"] li').or(page.getByRole('button', { name: 'Add a note' })).first();
  if (!(await waits.waitFor({ timeout: 3000 }).then(() => true, () => false))) missing(`Quote on ${file} puts no quote above the message box`);

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

  step('Terminal');
  if (requested.some((url) => TERMINAL_CODE.test(url))) missing('the terminal’s code loads before its tab is opened');
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  if (wide) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.keyboard.press('Control+Backquote');
    view = page.locator('aside[aria-label="Changes and files"]');
    if (!(await view.waitFor({ timeout: 5000 }).then(() => true, () => false))) return missing('Ctrl+` does not open the terminal');
  } else {
    view = await openWorkspace(page, `${url}&w=terminal`);
    if (!view) return missing('the Terminal tab does not open');
  }
  if (!(await view.getByText(/nothing runs here/).first().waitFor({ timeout: 8000 }).then(() => true, () => false))) missing('the Terminal tab does not say that nothing runs in the demo');
  if (!requested.some((url) => TERMINAL_CODE.test(url))) missing('the Terminal tab shows without its code');
  if (await view.getByRole('button', { name: 'Terminal', exact: true }).getAttribute('aria-pressed') !== 'true') missing('the Terminal tab is not the one shown');
  await page.waitForLoadState('networkidle');
}

/**
 * A quote with a note, as someone takes one: words of a reply selected, Quote, a note, and the
 * message sent; the prompt then reads back with the quote set apart. On a phone the pair docks
 * above the message box and Quote leaves a card there with Add a note; with a mouse, ↵ quotes and
 * the note box opens at the selection.
 */
async function walkQuote(page, base, session, where, phone) {
  const missing = (what) => problems.push(`${where}, session ${session.id}: ${what}`);
  await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  // The first words of a paragraph of a reply: under a finger they are selected as the system's
  // long press would, after a touch; with a mouse, dragged over with its button down.
  const words = await page.evaluate((touch) => {
    const paragraph = [...document.querySelectorAll('[data-quote-what="reply"] p')].find((p) => (p.firstChild?.textContent ?? '').trim().split(/\s+/).length >= 4);
    const node = paragraph?.firstChild;
    if (!node) return undefined;
    paragraph.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.split(/\s+/).slice(0, 3).join(' ').length);
    const box = range.getBoundingClientRect();
    if (touch) {
      paragraph.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    return { text: range.toString(), from: { x: box.left + 1, y: box.top + box.height / 2 }, to: { x: box.right - 1, y: box.top + box.height / 2 } };
  }, phone);
  if (!words) return missing('no paragraph of a reply to quote');
  if (!phone) {
    await page.mouse.move(words.from.x, words.from.y);
    await page.mouse.down();
    await page.mouse.move(words.to.x, words.to.y, { steps: 6 });
    await page.mouse.up();
  }
  const actions = page.getByRole('toolbar', { name: 'Selected text' });
  if (!(await actions.waitFor({ timeout: 2000 }).then(() => true, () => false))) return missing('selecting words of a reply offers no Quote');
  const note = 'Keep this as it is';
  if (phone) {
    await actions.getByRole('button', { name: 'Quote' }).click();
    const add = page.getByRole('button', { name: 'Add a note' });
    if (!(await add.waitFor({ timeout: 2000 }).then(() => true, () => false))) return missing('Quote on a phone leaves no card with Add a note');
    await add.click();
    await page.getByLabel('Your note').fill(note);
  } else {
    await page.keyboard.press('Enter');
    const box = page.getByRole('dialog', { name: 'Quote with a note' });
    if (!(await box.waitFor({ timeout: 2000 }).then(() => true, () => false))) return missing('↵ on a selection opens no note box');
    await page.keyboard.type(note);
    await page.keyboard.press('Enter');
    if (!(await page.locator('ul[aria-label="With your next message"] li').first().waitFor({ timeout: 2000 }).then(() => true, () => false))) return missing('the note box adds no chip above the message box');
  }
  await page.getByLabel('Message Claude').fill('And go on');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const quoted = page.locator('blockquote', { hasText: words.text.trim() }).first();
  if (!(await quoted.waitFor({ timeout: 3000 }).then(() => true, () => false))) return missing('the prompt sent shows no quote');
  if (await page.getByText('<!-- reply', { exact: false }).count()) missing('the prompt sent shows its reply marker');
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
 * The Pinned group, grouped by time and then by project: it comes first and holds the pinned
 * sessions. Then a pinned row's Unpin: on a phone beside Archive, under a finger's short slide to
 * the left, which stops short of acting, Archive at the edge (a slide to the right, Safari's Back,
 * shows nothing and opens nothing); on a computer in the menu of its ⋯, which takes the place of
 * its time as it is pointed at; and there, every row's ⋯, which cuts none of its words (see
 * walkRowButtons).
 */
async function walkPinned(page, sessions, size, where) {
  const pinned = sessions.filter((s) => s.pinned && !s.archived && s.title).map((s) => s.title);
  if (pinned.length === 0) {
    notes.push(`${where}: no session is pinned`);
    return;
  }
  const missing = (what) => problems.push(`${where}: ${what}`);
  const first = () => page.evaluate(() => {
    const section = document.querySelector('section');
    return {
      heading: section?.querySelector('h2, button[aria-expanded]')?.textContent?.trim().replace(/\d+$/, '') ?? '',
      rows: [...(section?.querySelectorAll('a[aria-label]') ?? [])].map((row) => row.getAttribute('aria-label')),
    };
  });
  for (const group of ['Time', 'Project']) {
    if (group === 'Project') {
      await page.getByRole('button', { name: 'List options', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Project', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    const { heading, rows } = await first();
    if (heading !== 'Pinned') missing(`grouped by ${group.toLowerCase()}, the list starts with "${heading}", not Pinned`);
    for (const title of pinned) if (!rows.some((row) => row.startsWith(`${title}, `))) missing(`grouped by ${group.toLowerCase()}, Pinned does not hold "${title}"`);
  }
  await page.getByRole('button', { name: 'List options', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Time', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const row = page.locator('section').first().locator('a[aria-label]').first();
  const box = await row.boundingBox();
  if (!box) return missing('the first pinned row has no place on the screen');
  if (size === 'phone') {
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const swipe = async (x, dx) => {
      await touch('touchStart', x);
      for (const part of [0.2, 0.45, 0.7, 0.9, 1]) await touch('touchMove', x + dx * part);
      await touch('touchEnd', x + dx);
      await page.waitForTimeout(300);
    };
    // What a slide shows under a row: its buttons, named as a screen reader names them.
    const under = page.locator('button[data-row-action]:not([aria-label])');
    await swipe(box.x + 60, 120);
    if (await under.count()) missing('a slide to the right on a pinned row shows buttons');
    if (new URL(page.url()).searchParams.has('s')) missing('a slide to the right on a pinned row opens it');
    await swipe(box.x + box.width - 60, -120);
    const unpin = page.getByRole('button', { name: 'Unpin', exact: true });
    const archive = page.getByRole('button', { name: 'Archive', exact: true });
    if (!(await unpin.waitFor({ timeout: 2000 }).then(() => true, () => false))) missing('a short slide to the left on a pinned row shows no Unpin');
    else {
      const [left, right] = [await unpin.boundingBox(), await archive.boundingBox().catch(() => null)];
      if (!left || !right || left.x + left.width > right.x + 1 || right.x + right.width < box.x + box.width - 1) {
        missing('a short slide to the left on a pinned row shows Unpin, but not beside Archive at the row’s edge');
      }
    }
    if (new URL(page.url()).searchParams.has('s')) missing('a short slide to the left on a pinned row opens it');
    // A tap elsewhere closes the row again.
    await page.mouse.click(5, 5);
    await cdp.detach();
  } else {
    await row.hover();
    const more = page.locator('section').first().locator('button[data-row-menu]').first();
    await page.waitForTimeout(250);
    if (!(await more.isVisible()) || !(await more.evaluate(shownOnScreen))) missing('pointing at a pinned row shows no ⋯');
    else {
      await more.click();
      const menu = await openMenu(page);
      if (!menu) missing('a pinned row’s ⋯ opens no menu');
      else if (lacks(menu, ['Unpin']).length) missing(`a pinned row’s ⋯ lists no Unpin (${menu.entries.join(', ')})`);
      await page.keyboard.press('Escape');
      await allClosed(page);
    }
    await walkRowButtons(page, where);
  }
  await page.waitForTimeout(250);
}

/** Whether an element shows: none of it or what holds it is hidden or see-through. Runs in the page. */
function shownOnScreen(el) {
  for (let at = el; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}

/**
 * The words of a row, pointed at, that its ⋯ cuts: words under the button, or under its icon where
 * the button is clear. The row's time gives it its place, hidden while it shows, and is not cut.
 * Runs in the page, on a row's link.
 */
function wordsCut(link) {
  const shown = (el) => {
    for (let at = el; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const row = link.closest('.group\\/row');
  const button = row.querySelector('button[data-row-menu]');
  if (!button || !shown(button)) return ['(no ⋯ shows)'];
  const clear = (color) => color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color);
  const cover = (clear(getComputedStyle(button).backgroundColor) ? button.querySelector('svg') ?? button : button).getBoundingClientRect();
  const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const cut = [];
  const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || !shown(node.parentElement)) continue;
    // Words a box cuts off (truncate, line-clamp) show only inside it.
    let clip = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
    for (let at = node.parentElement; at && at !== row; at = at.parentElement) {
      if (getComputedStyle(at).overflow === 'visible') continue;
      const box = at.getBoundingClientRect();
      clip = { left: Math.max(clip.left, box.left), right: Math.min(clip.right, box.right), top: Math.max(clip.top, box.top), bottom: Math.min(clip.bottom, box.bottom) };
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const box of range.getClientRects()) {
      const line = { left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right), top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom) };
      if (line.right > line.left && line.bottom > line.top && meet(line, cover)) cut.push(node.textContent.trim().slice(0, 40));
    }
  }
  return cut;
}

/**
 * On a computer, every row pointed at, compact and detailed, as wide as the window lets the list
 * be and on a tablet's width: its ⋯ shows in place of its time, and cuts none of its words.
 */
async function walkRowButtons(page, where) {
  const viewport = page.viewportSize();
  for (const width of [viewport.width, 768]) {
    await page.setViewportSize({ width, height: viewport.height });
    for (const density of ['Compact', 'Detailed']) {
      await page.getByRole('button', { name: 'List options', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: density, exact: true }).click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // A compact row's time on one line, a date ("Oct 25") too.
      if (density === 'Compact') {
        const wrapped = await page.locator('a[href^="?s="] span.tabular-nums').evaluateAll((spans) => spans.filter((span) => span.getClientRects().length > 1 || span.getBoundingClientRect().height > 24).map((span) => span.textContent));
        for (const time of wrapped) problems.push(`${where}, ${width}px, compact: the time "${time}" takes more than a line`);
      }
      const rows = page.locator('a[href^="?s="]');
      const count = Math.min(await rows.count(), 12);
      for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        if (!(await row.isVisible())) continue;
        await row.hover();
        await page.waitForTimeout(120);
        const title = (await row.getAttribute('aria-label'))?.split(', ')[0];
        for (const words of await row.evaluate(wordsCut)) problems.push(`${where}, ${width}px, ${density.toLowerCase()}: pointed at, "${title}" has "${words}" cut by its ⋯`);
      }
    }
  }
  await page.setViewportSize(viewport);
}

/**
 * The list, its sheets and its Pinned group, a new session in another folder, and every session
 * with its sheets; then Changes and files, walked through in `walked` (see walkable).
 */
/**
 * The list's first screen comes in one script: left to itself, Rolldown moves what the list shares
 * with a part loaded inside a lazily loaded one into a chunk of its own (`api`), which the page
 * then preloads and the list waits for too (vite.config.ts keeps them together).
 */
async function checkFirstScreen(base, where) {
  const page = await (await fetch(base)).text();
  const scripts = page.match(/<script\b[^>]*\bsrc=/g)?.length ?? 0;
  const preloaded = page.match(/<link\b[^>]*\brel="modulepreload"/g)?.length ?? 0;
  if (scripts !== 1 || preloaded > 0) problems.push(`${where}: the first screen loads ${scripts + preloaded} scripts, not one`);
}

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
      const requested = [];
      page.on('request', (request) => requested.push(request.url()));
      await page.goto(base, { waitUntil: 'networkidle' });
      for (const title of titles) {
        if (!(await page.getByText(title, { exact: true }).first().isVisible())) problems.push(`app, ${size}, ${scheme}: the list does not show "${title}"`);
      }
      at = 'the Pinned group';
      await walkPinned(page, sessions, size, `app, ${size}, ${scheme}`);
      at = 'the list';
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
        await pressSession(page, size === 'wide', `app, ${size}, session ${session.id}`);
      }
      at = 'Changes and files';
      if (walked) await walkWorkspace(page, base, walked, `app, ${size}, ${scheme}`, (what) => { at = `session ${walked.id}, ${what}`; }, requested);
      at = 'a quote with a note';
      if (walked) await walkQuote(page, base, walked, `app, ${size}, ${scheme}`, size === 'phone');
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

/** What a session's menu lists from a row, and from the title (which has Transcript view and when it started too). */
const ROW_MENU = ['Rename', /^(Pin|Unpin)/, 'Fork', 'Export', /^(Archive|Unarchive)/];
const TITLE_MENU = ['Rename', 'Side chat', 'Fork', 'Export', /^(Archive|Unarchive)/];
/** What the message box's + lists. */
const ADD_MENU = ['Add files or photos', 'Commands', 'Files and agents', 'Shell command', 'MCP servers'];

/**
 * A session to walk the ways in through, idle, with a prompt, a reply and a step with a menu; and
 * where some session has them, one with a path and one with a link in a reply.
 */
async function sessionsToWalk(page, base, sessions) {
  const found = {};
  for (const session of sessions.filter((s) => !s.sideChatOf && s.status === 'idle')) {
    await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const has = await page.evaluate(() => {
      const seen = (el) => el.getClientRects().length > 0;
      return {
        conversation: Boolean(document.querySelector('[data-quote-what="prompt"]') && document.querySelector('[data-quote-what="reply"] [data-reply-text]')
          && document.querySelector('[data-step] > button[aria-haspopup="menu"]')),
        path: [...document.querySelectorAll('main [data-path-link]')].some(seen),
        link: [...document.querySelectorAll('[data-reply-text] a[href]:not([data-path-link])')].some(seen),
      };
    });
    for (const [part, there] of Object.entries(has)) if (there && !found[part]) found[part] = session;
    if (found.conversation && found.path && found.link) break;
  }
  return found;
}

/** The first step with a menu of its own, as a locator. */
async function stepWithMenu(page) {
  const index = await page.evaluate(() => [...document.querySelectorAll('[data-step]')].findIndex((step) => step.querySelector(':scope > button[aria-haspopup="menu"]')));
  return index >= 0 ? page.locator('[data-step]').nth(index) : undefined;
}

/**
 * The ways in to every action, on a computer: a row's ⋯ in place of its time, and its right-click;
 * the title's menu, with when the session started and its ID, and its Rename; the message box's +
 * and its MCP servers; / and ⌘K with one list, Claude Code's commands in it, ⌘K finding a session
 * by its name and opening it; a prompt's actions beside it as it is pointed at, and its
 * right-click; a reply's row, in room kept for it, its ⋯, and a right-click on words selected in it
 * that puts Copy first; a step's ⋯ and right-click; a path's right-click; a link's right-click, the
 * browser's own; ⌘/; and the sidebar, hidden with its button and remembered, floating in at the
 * window's left edge or its button and gone as the pointer leaves or with Esc, back with ⌘B, and
 * between 1024 and 1279px hidden while a pane sits beside the conversation.
 */
async function waysInOnComputer(browser, base, sessions, where) {
  const context = await browser.newContext({ ...SIZES.wide });
  const page = await context.newPage();
  let at = 'a session to walk';
  watch(page, () => `${where}, ways in on a computer, ${at}`);
  const missing = (what) => problems.push(`${where}, ways in on a computer, ${at}: ${what}`);
  const found = await sessionsToWalk(page, base, sessions);
  const session = found.conversation;
  if (!session) {
    problems.push(`${where}: no idle session has a prompt, a reply and a step to walk the ways in through`);
    await context.close();
    return found;
  }
  const url = `${base}?s=${encodeURIComponent(session.id)}`;
  const close = async (what) => {
    await page.keyboard.press('Escape');
    if (!(await allClosed(page))) missing(`Esc leaves ${what} open`);
  };
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  at = 'a row';
  const row = page.locator('aside[data-list] [data-session]').first();
  const rowTitle = (await row.locator('a[aria-label]').first().getAttribute('aria-label'))?.split(', ')[0];
  await row.hover();
  await page.waitForTimeout(250);
  const more = row.locator('button[data-row-menu]');
  if (!(await more.evaluate(shownOnScreen))) missing('pointing at a row shows no ⋯');
  await more.click();
  let menu = await openMenu(page);
  if (!menu) missing('a row’s ⋯ opens no menu');
  else {
    if (menu.name !== rowTitle) missing(`a row’s menu is named "${menu.name}", not "${rowTitle}"`);
    const lacking = lacks(menu, ROW_MENU);
    if (lacking.length) missing(`a row’s menu lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await close('a row’s menu');
  }
  await row.click({ button: 'right' });
  menu = await openMenu(page);
  if (!menu || menu.name !== rowTitle) missing('a right-click on a row opens no menu of its own');
  else await close('a row’s menu');

  at = 'the title’s menu';
  await page.locator(TITLE).click();
  menu = await openMenu(page);
  if (!menu) missing('the title opens no menu');
  else {
    const lacking = lacks(menu, TITLE_MENU);
    if (lacking.length) missing(`it lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    if (!menu.text.includes('Transcript view')) missing('it has no Transcript view');
    if (!/ID [0-9a-f]{8}/.test(menu.text)) missing('it does not say the session’s ID');
    await page.getByRole('menuitem', { name: /^Rename/ }).click();
    if (!(await shows(page.getByRole('textbox', { name: 'Session title' })))) missing('its Rename opens no Rename sheet');
    await close('the Rename sheet');
  }

  at = 'the message box’s +';
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  menu = await openMenu(page);
  if (!menu) missing('+ opens no menu');
  else {
    const lacking = lacks(menu, ADD_MENU);
    if (lacking.length) missing(`+ lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await page.getByRole('menuitem', { name: /^MCP servers/ }).click();
    if (!(await shows(page.getByRole('dialog', { name: /^MCP servers/ })))) missing('its MCP servers opens nothing');
    await close('MCP servers');
  }

  at = 'the message box’s /';
  const box = page.getByLabel('Message Claude');
  await box.click();
  await page.keyboard.type('/');
  const commands = page.getByRole('listbox', { name: 'Commands' });
  if (!(await shows(commands))) missing('/ shows no list of commands');
  else {
    // Claude Code's own come once the session's list of them has.
    await commands.getByRole('option').filter({ hasText: '/compact' }).first().waitFor({ timeout: 5000 }).catch(() => {});
    const options = await commands.getByRole('option').allTextContents();
    for (const name of ['/rename', '/branch', '/compact']) if (!options.some((option) => option.includes(name))) missing(`it lists no ${name}`);
    if (options.filter((option) => option.includes('/context')).length !== 1) missing('it lists /context other than once');
  }
  await box.fill('');
  await page.keyboard.press('Escape');

  at = '⌘K';
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ControlOrMeta+k');
  const commandMenu = page.getByRole('dialog', { name: 'Command menu' });
  if (!(await shows(commandMenu))) missing('⌘K opens no command menu');
  else {
    const field = commandMenu.getByRole('combobox', { name: 'Type a command or search' });
    if (!(await field.evaluate((el) => el === document.activeElement))) missing('its field does not take the keys');
    await commandMenu.getByRole('option').filter({ hasText: '/compact' }).first().waitFor({ timeout: 5000 }).catch(() => {});
    const options = await commandMenu.getByRole('option').allTextContents();
    for (const name of ['Rename', 'New session', 'Settings']) if (!options.some((option) => option.startsWith(name))) missing(`it lists no ${name}`);
    if (!options.some((option) => option.startsWith('/compact'))) missing('it lists none of Claude Code’s commands');
    const other = sessions.find((s) => s.id !== session.id && !s.sideChatOf && s.title);
    if (other) {
      await field.fill(other.title);
      const option = commandMenu.getByRole('option').filter({ hasText: other.title }).first();
      if (!(await shows(option))) missing(`it does not find "${other.title}"`);
      else {
        await option.click();
        if (!(await page.waitForURL((address) => address.searchParams.get('s') === other.id, { timeout: 5000 }).then(() => true, () => false))) missing(`picking "${other.title}" does not open it`);
      }
    }
  }
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  at = 'a prompt';
  const prompt = page.locator('[data-quote-what="prompt"]').first();
  await prompt.scrollIntoViewIfNeeded();
  await prompt.hover();
  await page.waitForTimeout(400);
  const beside = await prompt.evaluate((el) => [...el.parentElement.querySelectorAll(':scope > div > button[aria-label]')]
    .filter((button) => Number(getComputedStyle(button.parentElement).opacity) > 0.5).map((button) => button.getAttribute('aria-label')));
  for (const name of ['Copy', 'Fork from here']) if (!beside.includes(name)) missing(`pointing at it shows no ${name} beside it (it shows ${beside.join(', ') || 'none'})`);
  await prompt.click({ button: 'right' });
  menu = await openMenu(page);
  if (!menu) missing('a right-click on it opens no menu');
  else {
    const lacking = lacks(menu, ['Copy', 'Rewind to here', 'Fork from here']);
    if (lacking.length) missing(`its menu lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await close('a prompt’s menu');
  }

  at = 'a reply';
  const reply = page.locator('[data-quote-what="reply"]').filter({ has: page.locator('[data-reply-text]') }).last();
  await reply.scrollIntoViewIfNeeded();
  const replyMore = reply.getByRole('button', { name: 'More for Claude’s reply' });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  const before = await reply.boundingBox();
  if (await replyMore.evaluate(shownOnScreen)) missing('its row shows before it is pointed at');
  await reply.hover();
  await page.waitForTimeout(400);
  if (!(await replyMore.evaluate(shownOnScreen))) missing('pointing at it shows no row');
  const after = await reply.boundingBox();
  if (before && after && Math.abs(before.height - after.height) > 0.5) missing(`it grows ${Math.round(after.height - before.height)}px as its row shows`);
  await replyMore.click();
  menu = await openMenu(page);
  if (!menu) missing('its ⋯ opens no menu');
  else {
    const lacking = lacks(menu, ['Copy message', 'Copy message as Markdown', 'Quote message', 'Fork from here']);
    if (lacking.length) missing(`its menu lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await close('a reply’s menu');
  }
  const words = reply.locator('[data-reply-text] p').first();
  if (await words.count()) {
    await words.click({ clickCount: 3 });
    await words.click({ button: 'right' });
    menu = await openMenu(page);
    if (!menu) missing('a right-click on words selected in it opens no menu');
    else {
      if (!/^Copy(?! message)/.test(menu.entries[0] ?? '')) missing(`a right-click on words selected in it does not put Copy first (it lists ${menu.entries.join(', ')})`);
      if (lacks(menu, ['Quote selection']).length) missing('a right-click on words selected in it offers no Quote selection');
      await close('a reply’s menu');
    }
  }

  at = 'a step';
  const step = await stepWithMenu(page);
  if (step) {
    await step.scrollIntoViewIfNeeded();
    await step.hover({ position: { x: 40, y: 12 } });
    await page.waitForTimeout(300);
    const stepMore = step.locator('button[aria-haspopup="menu"]').first();
    if (!(await stepMore.evaluate(shownOnScreen))) missing('pointing at it shows no ⋯');
    await stepMore.click();
    menu = await openMenu(page);
    if (!menu?.entries.length) missing('its ⋯ opens no menu');
    else await close('a step’s menu');
    await step.click({ button: 'right', position: { x: 40, y: 12 } });
    menu = await openMenu(page);
    if (!menu?.entries.length) missing('a right-click on it opens no menu');
    else await close('a step’s menu');
  }

  at = 'a path';
  if (found.path) {
    await page.goto(`${base}?s=${encodeURIComponent(found.path.id)}`, { waitUntil: 'networkidle' });
    const path = page.locator('main [data-path-link]').filter({ visible: true }).first();
    await path.scrollIntoViewIfNeeded();
    await path.click({ button: 'right' });
    menu = await openMenu(page);
    if (!menu) missing('a right-click on a path opens no menu');
    else {
      const lacking = lacks(menu, ['Copy', /^Open in (Files|Changes)/]);
      if (lacking.length) missing(`its menu lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
      await close('a path’s menu');
    }
  } else notes.push(`${where}: no session shows a path to right-click`);

  at = 'a link';
  if (found.link) {
    await page.goto(`${base}?s=${encodeURIComponent(found.link.id)}`, { waitUntil: 'networkidle' });
    const link = page.locator('[data-reply-text] a[href]:not([data-path-link])').filter({ visible: true }).first();
    await link.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.addEventListener('contextmenu', (e) => {
      window.smokeMenuTaken = e.defaultPrevented;
    }, { once: true }));
    await link.click({ button: 'right' });
    if (await page.evaluate(() => window.smokeMenuTaken !== false)) missing('a right-click on a link in a reply does not leave the browser its own menu');
    if (await openMenu(page, 600)) {
      missing('a right-click on a link in a reply opens Pelican’s menu');
      await close('a menu');
    }
  } else notes.push(`${where}: no reply has a link to right-click`);

  at = '⌘/';
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.keyboard.press('ControlOrMeta+/');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  if (!(await shows(shortcuts))) missing('⌘/ opens no list of keys');
  else {
    const text = await shortcuts.textContent();
    for (const name of ['Command menu', 'Search sessions', 'Show or hide the sidebar']) if (!text.includes(name)) missing(`it lists no ${name}`);
    await close('Keyboard shortcuts');
  }

  at = 'the sidebar';
  const list = page.locator('aside[data-list]');
  const listShown = () => list.evaluate((el) => !el.hasAttribute('inert'));
  const conversationLeft = async () => (await page.locator('main').boundingBox())?.x ?? 0;
  const hide = list.getByRole('button', { name: 'Hide sidebar' });
  if (!(await hide.count())) missing('the list has no Hide sidebar');
  else {
    await hide.click();
    await page.waitForTimeout(300);
    if (await listShown()) missing('Hide sidebar leaves the list');
    const show = page.locator(CHAT_HEADER).getByRole('button', { name: 'Show sidebar' });
    if (!(await show.count())) missing('hidden, the list leaves no Show sidebar in the conversation’s header');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    if (await listShown()) missing('hidden, the list comes back on a reload');
    await page.mouse.move(2, 400);
    await page.waitForTimeout(400);
    if (!(await listShown())) missing('the window’s left edge does not float the list in');
    else {
      if (await conversationLeft() > 1) missing('the list floating in moves the conversation over');
      await page.mouse.move(900, 400);
      await page.waitForTimeout(700);
      if (await listShown()) missing('the list floating in stays once the pointer leaves it');
    }
    await show.hover();
    await page.waitForTimeout(400);
    if (!(await listShown())) missing('pointing at Show sidebar does not float the list in');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await listShown()) missing('Esc leaves the list floating in');
    await page.mouse.move(900, 400);
    await page.keyboard.press('ControlOrMeta+b');
    await page.waitForTimeout(300);
    if (!(await listShown())) missing('⌘B does not bring the list back');
    else if (await conversationLeft() < 100) missing('the list back sits over the conversation');
  }
  at = 'the sidebar at 1100px';
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const files = page.locator(CHAT_HEADER).getByRole('button', { name: 'Files', exact: true });
  if (!(await listShown())) missing('the list is hidden with no pane beside the conversation');
  else if (await files.count()) {
    await files.click();
    await page.waitForTimeout(400);
    if (await listShown()) missing('the list stays as Files comes beside the conversation');
    await page.keyboard.press('ControlOrMeta+b');
    await page.waitForTimeout(300);
    if (!(await listShown())) missing('⌘B does not bring the list back beside a pane');
    await files.click();
    await page.waitForTimeout(400);
    if (!(await listShown())) missing('the list does not stay once the pane goes');
  }
  await context.close();
  return found;
}

/**
 * The ways in on a phone: a row's long press, which opens it not; the title's sheet with the panes'
 * tiles, and a tile; a prompt's tap and long press; a reply's row, there without a tap; a step's
 * long press; +; /. Back closes each sheet with the page where it was, and a sheet closed by a tap
 * outside leaves nothing in the history for Back to go through.
 */
async function waysInOnPhone(browser, base, session, where) {
  const context = await browser.newContext({ ...SIZES.phone });
  const page = await context.newPage();
  let at = 'a row';
  watch(page, () => `${where}, ways in on a phone, ${at}`);
  const missing = (what) => problems.push(`${where}, ways in on a phone, ${at}: ${what}`);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  // A finger held still on it, past the long press's half second.
  const hold = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) return;
    const [x, y] = [box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 20)];
    await touch('touchStart', x, y);
    await page.waitForTimeout(700);
    await touch('touchEnd', x, y);
    await page.waitForTimeout(300);
  };
  const address = () => new URL(page.url()).search;
  // Back closes what is open and goes no further.
  const backCloses = async (what) => {
    const was = address();
    await page.goBack();
    if (!(await allClosed(page))) missing(`Back leaves ${what} open`);
    else if (address() !== was) missing(`Back from ${what} goes to ${address() || 'the list'} as it closes it`);
  };
  const url = `${base}?s=${encodeURIComponent(session.id)}`;
  const title = page.locator(TITLE);
  // Into the session from its row, as a tap goes, so that Back has the list to go back to in the
  // page (a page Back returns to from another is the browser's, kept as it was left).
  const enter = async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    const link = page.locator(`[data-session="${session.id}"] a`).first();
    if (!(await link.count())) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      return false;
    }
    await link.scrollIntoViewIfNeeded();
    await link.tap();
    await page.waitForURL((address) => address.searchParams.get('s') === session.id, { timeout: 5000 }).catch(() => {});
    await title.waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    return true;
  };

  await page.goto(base, { waitUntil: 'networkidle' });
  const row = page.locator('[data-session]').first();
  const rowTitle = (await row.locator('a[aria-label]').first().getAttribute('aria-label'))?.split(', ')[0];
  await hold(row);
  let menu = await openMenu(page);
  if (!menu) missing('a long press on a row opens no menu');
  else {
    if (menu.name !== rowTitle) missing(`a row’s menu is named "${menu.name}", not "${rowTitle}"`);
    const lacking = lacks(menu, ROW_MENU);
    if (lacking.length) missing(`a row’s menu lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await backCloses('a row’s menu');
  }
  if (new URL(page.url()).searchParams.has('s')) missing('a long press on a row opens its session');

  at = 'the title’s sheet';
  let inPage = await enter();
  await title.tap();
  menu = await openMenu(page);
  if (!menu) missing('a tap on the title opens no sheet');
  else {
    const tiles = await page.locator('dialog[open]').last().getByRole('button').allTextContents();
    for (const tile of ['Changes', 'Files', 'Terminal']) if (!tiles.some((name) => name.startsWith(tile))) missing(`it has no ${tile} tile`);
    const lacking = lacks(menu, TITLE_MENU);
    if (lacking.length) missing(`it lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await backCloses('the title’s sheet');
    if (inPage) {
      await page.goBack();
      await page.waitForTimeout(400);
      if (new URL(page.url()).searchParams.has('s')) missing('Back once the sheet is closed does not go back to the list');
    }
  }

  at = 'a tile';
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await title.tap();
  const files = page.locator('dialog[open]').last().getByRole('button', { name: 'Files', exact: true });
  if (!(await openMenu(page)) || !(await files.count())) missing('the title’s sheet has no Files tile to tap');
  else {
    await files.tap();
    const view = page.locator('[role="region"][aria-label="Changes and files"], aside[aria-label="Changes and files"]');
    if (!(await shows(view))) missing('the Files tile opens no Files');
    else {
      await page.goBack();
      if (!(await view.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false))) missing('Back leaves Files open');
      if (new URL(page.url()).searchParams.get('s') !== session.id) missing('Back from Files leaves the conversation');
    }
  }

  at = 'a prompt';
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const prompt = page.locator('[data-quote-what="prompt"]').first();
  await prompt.scrollIntoViewIfNeeded();
  await prompt.tap();
  if (!(await shows(page.getByRole('button', { name: 'Fork from here', exact: true }).first(), 2000))) missing('a tap on it shows no Fork from here');
  await hold(prompt);
  menu = await openMenu(page);
  if (!menu) missing('a long press on it opens no sheet');
  else {
    const lacking = lacks(menu, ['Copy', 'Rewind to here', 'Fork from here', 'Select text']);
    if (lacking.length) missing(`its sheet lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await backCloses('a prompt’s sheet');
  }

  at = 'a reply';
  const reply = page.locator('[data-quote-what="reply"]').filter({ has: page.locator('[data-reply-text]') }).last();
  await reply.scrollIntoViewIfNeeded();
  const replyMore = reply.getByRole('button', { name: 'More for Claude’s reply' });
  if (!(await replyMore.count()) || !(await replyMore.evaluate(shownOnScreen))) missing('it shows no row of actions');
  else {
    await replyMore.tap();
    menu = await openMenu(page);
    if (!menu) missing('its ⋯ opens no sheet');
    else {
      const lacking = lacks(menu, ['Copy message', 'Copy message as Markdown', 'Quote message']);
      if (lacking.length) missing(`its sheet lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
      await backCloses('a reply’s sheet');
    }
  }

  at = 'a step';
  const step = await stepWithMenu(page);
  if (step) {
    await hold(step);
    menu = await openMenu(page);
    if (!menu?.entries.length) missing('a long press on it opens no sheet');
    else await backCloses('a step’s sheet');
  }

  at = 'the message box’s +';
  await page.getByRole('button', { name: 'Add', exact: true }).tap();
  menu = await openMenu(page);
  if (!menu) missing('+ opens no sheet');
  else {
    const lacking = lacks(menu, ADD_MENU);
    if (lacking.length) missing(`+ lacks ${lacking.join(', ')} (it lists ${menu.entries.join(', ')})`);
    await backCloses('+');
  }

  at = 'the message box’s /';
  const box = page.getByLabel('Message Claude');
  await box.tap();
  await page.keyboard.type('/');
  if (!(await shows(page.getByRole('listbox', { name: 'Commands' })))) missing('/ shows no list of commands');
  await box.fill('');

  at = 'a sheet closed by a tap outside';
  inPage = await enter();
  await title.tap();
  if (await openMenu(page)) {
    await page.waitForTimeout(300);
    await page.touchscreen.tap(195, 40);
    if (!(await allClosed(page))) missing('a tap outside leaves the sheet open');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => Boolean(history.state?.pelicanSheet))) missing('closed, the sheet leaves its place in the history');
    else if (inPage) {
      await page.goBack();
      await page.waitForTimeout(400);
      if (new URL(page.url()).searchParams.has('s')) missing('Back after it does not go back to the list');
    }
  } else missing('a tap on the title opens no sheet');
  await cdp.detach();
  await context.close();
}

/** The ways in to every action, on a computer and on a phone (see waysInOnComputer and waysInOnPhone). */
async function checkWaysIn(browser, base, sessions, where) {
  const found = await waysInOnComputer(browser, base, sessions, where);
  if (found.conversation) await waysInOnPhone(browser, base, found.conversation, where);
}

/**
 * The files Claude sent, in the sessions where Claude Code recorded one delivered (`answer` asks the
 * demo for a session's messages, or reads the answer the site saved), on a phone and wide, light
 * and dark: each shows, a picture loaded, with a way to save it, and a picture opens large.
 */
async function checkSentFiles(browser, base, sessions, answer) {
  const sending = [];
  for (const session of sessions) {
    const page = await answer(`sessions/${encodeURIComponent(session.id)}/messages?limit=120`).catch(() => undefined);
    const sent = (page?.messages ?? []).flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result' && b.delivered?.files?.length);
    if (sent.length > 0) sending.push(session);
  }
  if (sending.length === 0) problems.push('the demo has no session where Claude sent a file');
  for (const [size, options] of Object.entries(SIZES)) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      const page = await context.newPage();
      let at = '';
      watch(page, () => `app, sent files, ${size}, ${scheme}, ${at}`);
      for (const session of sending) {
        at = `session ${session.id}`;
        await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
        const group = page.locator('[role="group"][aria-label^="Sent "]').first();
        if (!(await group.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
          problems.push(`app, sent files, ${size}, ${scheme}, ${at}: the file Claude sent does not show`);
          continue;
        }
        await group.scrollIntoViewIfNeeded();
        await page.waitForLoadState('networkidle');
        const found = await group.evaluate((el) => {
          const out = [];
          for (const img of el.querySelectorAll('img')) if (!img.complete || img.naturalWidth === 0) out.push(`the picture ${img.alt} does not load`);
          if (!el.querySelector('a[download]')) out.push('there is no way to save the file');
          const box = el.getBoundingClientRect();
          if (box.right > innerWidth + 1) out.push(`it ends ${Math.round(box.right - innerWidth)}px past the window`);
          return out;
        });
        problems.push(...found.map((problem) => `app, sent files, ${size}, ${scheme}, ${at}: ${problem}`));
        const open = group.getByRole('button', { name: /^Open / }).first();
        if (await open.count()) {
          await open.click();
          if (!(await page.getByRole('dialog', { name: 'Image' }).waitFor({ timeout: 3000 }).then(() => true, () => false))) problems.push(`app, sent files, ${size}, ${scheme}, ${at}: the picture does not open large`);
          await page.keyboard.press('Escape');
        }
      }
      await context.close();
    }
  }
}

/**
 * Export, from the title's menu of a few sessions: a file of Markdown downloads, with the
 * conversation in it, on the site too, which saved each from the demo.
 */
async function checkExport(browser, base, sessions, where) {
  const context = await browser.newContext({ ...SIZES.wide, acceptDownloads: true });
  const page = await context.newPage();
  let at = '';
  watch(page, () => `${where}, export, ${at}`);
  for (const session of sessions.slice(0, 3)) {
    at = `session ${session.id}`;
    await page.goto(`${base}?s=${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
    await page.locator(TITLE).click();
    const downloaded = page.waitForEvent('download', { timeout: 10_000 }).catch(() => undefined);
    await page.getByRole('menu', { name: 'Session' }).getByRole('menuitem', { name: 'Export' }).click();
    const download = await downloaded;
    if (!download) {
      problems.push(`${where}, export, ${at}: nothing downloads`);
      continue;
    }
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const markdown = Buffer.concat(chunks).toString('utf8');
    if (!/^# .+\n/.test(markdown) || !/^## (?:You|Claude)$/m.test(markdown)) problems.push(`${where}, export, ${at}: ${download.suggestedFilename()} is no conversation: ${JSON.stringify(markdown.slice(0, 80))}`);
    if (!download.suggestedFilename().endsWith('.md')) problems.push(`${where}, export, ${at}: saved as ${download.suggestedFilename()}`);
    await page.keyboard.press('Escape');
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
        if (await pick.waitFor({ timeout: 5000 }).then(() => true, () => false)) await pick.click();
        else problems.push(`app, usage, ${size}: no "${range}" range`);
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
  for (const file of (await readdir(data)).filter((name) => name.endsWith('.json'))) {
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
    await checkFirstScreen(`${server.base}demo/`, 'site, demo');
    const sessions = await savedSessions(site);
    const saved = (request) => readFile(path.join(site, 'demo', 'data', `${requestKey(request)}.json`), 'utf8').then(JSON.parse);
    await driveApp(browser, `${server.base}demo/`, sessions, await walkable(sessions, saved));
    await checkSentFiles(browser, `${server.base}demo/`, sessions, saved);
    await checkExport(browser, `${server.base}demo/`, sessions, 'site, demo');
    await checkWaysIn(browser, `${server.base}demo/`, sessions, 'site, demo');
    await checkUsage(browser, `${server.base}demo/`);
  } else {
    const demo = await startDemo({ port: Number(process.env.PELICAN_DEMO_PORT ?? 47863), name: 'smoke' });
    stop = demo.stop;
    const { sessions } = await (await fetch(`${demo.base}api/sessions`, { headers: MARK })).json();
    if (!sessions?.length) problems.push('the demo has no sessions');
    await checkFirstScreen(demo.base, 'app');
    const asked = (request) => fetch(`${demo.base}api/${request}`, { headers: MARK }).then((r) => r.json());
    await driveApp(browser, demo.base, sessions ?? [], await walkable(sessions ?? [], asked));
    await checkDocked(browser, demo.base, sessions ?? []);
    await checkSideChat(browser, demo.base, sessions ?? []);
    await checkWaysIn(browser, demo.base, sessions ?? [], 'app');
    await checkSentFiles(browser, demo.base, sessions ?? [], asked);
    await checkExport(browser, demo.base, sessions ?? [], 'app');
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

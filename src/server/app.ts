import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';

import pkg from '../../package.json' with { type: 'json' };
import { type DefaultChange, isSavedEffort } from '../shared/defaults.js';
import { isPermissionMode } from '../shared/modes.js';
import { USAGE_RANGES, type UsageRange } from '../shared/usage.js';
import { PREVIEW_CDNS, PREVIEW_POLICY } from '../shared/preview-policy.js';
import type { Attachment, PermissionDecision, RewindRestore, RunSettings, SendMode, ServerInfo } from '../shared/protocol.js';
import { revealHidden } from '../shared/hidden.js';
import { commandRefusal, sizeAllowed, TERMINAL_LIMITS, terminalColors } from '../shared/terminal.js';
import { currentTasks } from '../shared/tasks.js';
import { exportMarkdown, fork, remove } from './actions.js';
import { forget, keep } from './kept.js';
import { authMode, beginAttempt, checkPassword, checkToken, cookieName, issueCode, newSessionCookie, proofValid, redeemCode, renewedCookie, signedIn, signOut } from './auth.js';
import { config } from './config.js';
import { demoRunState, demoTaskOutput } from './demo.js';
import { sessionsChanged } from './feed.js';
import { findUpload, FolderError, listDirs, makeDir, MAX_UPLOAD_BYTES, saveUpload } from './files.js';
import { claudeCodeInfo, newerClaude } from './claude-code.js';
import { createScratchFolder, isDirectory, pickFolder } from './folders.js';
import { readDefaults, saveDefault, SettingsRefused } from './defaults.js';
import { listCompletions, listModels, planUsage, probeMcpServers } from './models.js';
import { searchFiles } from './project-files.js';
import { exactBytes } from './open.js';
import { pullRequestStatus } from './pull-requests.js';
import { findPhoneAddress } from './phone.js';
import { addSubscription, pushKey, removeSubscription } from './push.js';
import { getRun, runIn, runState, runStatus, runTasks, sendMessage, startSideChat } from './runner.js';
import { checkRewind, promptBack, RewindRefusal, rewindTo, undoRewind } from './rewind.js';
import { liveCut } from './rewound.js';
import { savedOutputPage } from './shell.js';
import { startShell, stopShell } from './shell-runs.js';
import { isSideChat } from './side-chat.js';
import { shownRun } from './stream.js';
import { usageLimits } from './usage.js';
import { EXISTS_MAX, existingFiles, gitDiff, gitStatus, listTree, openProjectFile, PICTURE_TYPES, readProjectFile, typeOf } from './workspace.js';
import { searchText } from './search.js';
import { closeTerminal, listTerminals, openTerminal, terminalAvailability, terminalRunning, terminalsReady, terminalsRefused, TooManyTerminals } from './terminals.js';
import { sessionChanges, turnDiff } from './changes.js';
import { readStatsCache, refreshUsage, sessionFiles, sessionUsage, summarize } from './stats.js';
import { hostAllowed, isLoopback, originAllowed } from './security.js';
import { listSummaries, loadPage, recordedSettings, renameSessionTitle, sentFiles, sessionInfo, sessionSummary, shownMessages } from './sessions.js';
import { entryBefore, transcriptImage } from './history.js';
import { instance } from './running.js';
import { transcriptPath } from './transcripts.js';
import { folderTrusted, launchFor, NeedsTrust, rememberChoice, type TrustChoice, trustQuestion } from './trust.js';
import { updateRoutes, whileUpdating } from './update.js';
import { AGENT_ID, CALL_ID, subagentPage, workflowAgentPage, workflowCalls, workflowView } from './workflows.js';

export const app = new Hono();

/**
 * Who is asking, for limiting sign-in attempts: the address of the connection.
 * Behind a proxy on this machine that says so (PELICAN_TRUSTED_PROXY=1), the
 * client the proxy added last to X-Forwarded-For, when that is an IP address.
 * Anyone can write that header, so it is never believed otherwise.
 */
function clientAddress(c: Context): string {
  let remote = 'unknown';
  try {
    remote = getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // Not served by Node (tests): one bucket for all.
  }
  const address = remote.replace(/^::ffff:/, '');
  if (config.trustedProxy && isLoopback(address)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return address;
}

const secure = (c: { req: { header: (name: string) => string | undefined; url: string } }) =>
  c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:');

const cookieHeader = (c: Context, name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(c) ? '; Secure' : ''}`;

/** Answers only to host names that point at this server (DNS rebinding). */
app.use('*', async (c, next) => {
  if (!hostAllowed(c.req.header('host'))) {
    return c.text('This host name is not allowed. Add it to PELICAN_ALLOWED_HOSTS.', 403);
  }
  await next();
});

/** What the page loads without fetch, so it cannot mark: an uploaded image, a picture in a message, a file Claude sent, a download. */
const unmarked = (c: Context) => c.req.method === 'GET'
  && (/^\/api\/uploads\/[^/]+$/.test(c.req.path) || /^\/api\/sessions\/[^/]+\/export$/.test(c.req.path)
    || /^\/api\/sessions\/[^/]+\/images\/[^/]+\/\d+$/.test(c.req.path) || c.req.path === '/api/file/raw'
    || /^\/api\/sessions\/[^/]+\/sent\/raw$/.test(c.req.path));

/** The Origin header as an origin (`null`, garbage and missing are none). */
function originOf(header: string | undefined): string | undefined {
  if (!header || header === 'null') return undefined;
  try {
    return new URL(header).origin;
  } catch {
    return undefined;
  }
}

/** `pelican phone` asking for a phone code, with a proof made for this very request (auth.ts), not a cookie. */
const commandAsks = (c: Context) => c.req.method === 'POST' && c.req.path === '/api/access/code'
  && proofValid(c.req.header('x-pelican-proof'), 'POST', '/api/access/code', instance);

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  const parsed = originOf(origin);
  const allowedOrigin = Boolean(parsed && config.allowedOrigins.includes(parsed));
  // Another site's page can make a browser send requests here, reads included, and some reads
  // run programs (git, Claude Code). Browsers say where a request comes from: only Pelican's own
  // page, or a page the config allows, gets in.
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none' && !allowedOrigin) {
    return c.json({ error: 'Request from another site' }, 403);
  }
  // Pelican's page also marks every request. Another site cannot add a header without asking
  // first (CORS), and Pelican never says yes, so this holds in browsers that send no Sec-Fetch-Site.
  if (!unmarked(c) && c.req.header('x-pelican') !== '1') {
    return c.json({ error: 'Requests must come from Pelican (send the header X-Pelican: 1)' }, 403);
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD'
    && !originAllowed(origin, c.req.header('host'), c.req.header('x-forwarded-host'))) {
    return c.json({ error: 'Request from another site' }, 403);
  }
  if (!c.req.path.startsWith('/api/auth') && !signedIn(c.req.header('cookie'), c.req.header('authorization')) && !commandAsks(c)) {
    return c.json({ error: 'Sign in to continue', signIn: true }, 401);
  }
  // Use keeps a browser signed in: its cookie is replaced by a fresh one (at most once a day).
  const renewed = c.req.path.startsWith('/api/auth/logout') ? undefined : renewedCookie(c.req.header('cookie'));
  if (renewed) c.header('Set-Cookie', cookieHeader(c, renewed.name, renewed.value, renewed.maxAge));
  if (config.demo && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'This is the demo: nothing runs and nothing changes. Start Pelican without --demo to talk to Claude.' }, 403);
  }
  await next();
});

// While an update replaces Pelican's install and starts it again, nothing new starts (update.ts).
app.use('/api/*', whileUpdating);

// Bodies are small, except an upload; nothing is buffered past these sizes. Only signed-in
// requests get this far, apart from signing in itself, whose limit is 4 KB.
const tooLarge = (c: Context) => c.json({ error: 'Request too large' }, 413);
const limits = {
  auth: bodyLimit({ maxSize: 4 * 1024, onError: tooLarge }),
  upload: bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: tooLarge }),
  json: bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }),
};
app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/auth') ? limits.auth : c.req.path === '/api/uploads' ? limits.upload : limits.json)(c, next));

// Answers are JSON that compresses well (a long session list or a page of messages, ten times
// over), and the proxies a phone comes through pass them on as they are. Images are left alone.
app.use('/api/*', compress({ threshold: 1024 }));

// Updating from Settings, behind the same limits as every other request.
app.route('/api/update', updateRoutes);

app.onError((error, c) => {
  // Starting Claude Code in a folder nobody trusted: the page asks, then sends again with the answer.
  if (error instanceof NeedsTrust) return c.json({ error: error.message, needsTrust: true, brings: error.brings, commands: error.commands, more: error.more }, 409);
  console.warn('[pelican]', c.req.method, c.req.path, error.message);
  return c.json({ error: error.message }, 500);
});

app.get('/api/auth', (c) => c.json({
  required: authMode() !== 'none',
  mode: authMode(),
  signedIn: signedIn(c.req.header('cookie'), c.req.header('authorization')),
  // Not a secret: lets `pelican phone` tell this server from another behind an address.
  instance,
}));

app.post('/api/auth/login', async (c) => {
  const succeeded = beginAttempt(clientAddress(c));
  if (!succeeded) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const body = await c.req.json<{ password?: unknown; token?: unknown }>().catch(() => ({} as { password?: unknown; token?: unknown }));
  const mode = authMode();
  const ok = mode === 'password' ? typeof body.password === 'string' && (await checkPassword(body.password))
    : mode === 'token' ? typeof body.token === 'string' && checkToken(body.token.trim())
      : false;
  if (!ok) return c.json({ error: mode === 'token' ? 'That is not the access token' : 'Wrong password', mode }, 401);
  succeeded();
  const cookie = newSessionCookie();
  c.header('Set-Cookie', cookieHeader(c, cookie.name, cookie.value, cookie.maxAge));
  return c.json({ ok: true });
});

app.post('/api/auth/logout', async (c) => {
  // The cookie is refused from now on, with every renewal of it, until it would have expired, and
  // what this browser has open (its live updates, its terminals) closes at once (auth.ts).
  await signOut(c.req.header('cookie'));
  c.header('Set-Cookie', cookieHeader(c, cookieName(), '', 0));
  // What the browser kept of Pelican (a conversation's pictures) goes too; where the browser does
  // not take this (an http address that is not this computer), the pictures are checked anyway.
  c.header('Clear-Site-Data', '"cache"');
  return c.json({ ok: true });
});

/** A one-time code for the QR code that signs a phone in: good once, for two minutes. */
app.post('/api/access/code', (c) => {
  if (authMode() === 'none') return c.json({ code: null });
  return c.json({ code: issueCode() });
});

/** The address a phone uses to reach this Pelican, when one is known: looked up at most once a minute. */
let phoneLookup: { at: number; url: Promise<string | null> } | undefined;
app.get('/api/access/phone', async (c) => {
  if (config.demo) return c.json({ url: null });
  if (!phoneLookup || Date.now() - phoneLookup.at > 60_000) {
    phoneLookup = { at: Date.now(), url: findPhoneAddress(config.port, config.host).then((found) => found.address?.url ?? null, () => null) };
  }
  return c.json({ url: await phoneLookup.url });
});

app.get('/api/info', async (c) => {
  const info: ServerInfo = { machine: config.machine, home: config.home, version: pkg.version, auth: authMode() !== 'none', demo: config.demo, terminal: terminalAvailability() };
  const key = pushKey();
  if (key) info.pushKey = key;
  // Which Claude Code this Pelican runs, for About (and bug reports), and the user's own when newer.
  const code = await claudeCodeInfo();
  const newer = newerClaude();
  if (code.version || code.path) {
    info.claudeCode = { ...(code.version ? { version: code.version } : {}), ...(code.path ? { path: code.path } : {}), ...(newer ? { newer } : {}) };
  }
  return c.json(info);
});

app.get('/api/sessions', async (c) => c.json({ sessions: await listSummaries(runStatus, runTasks) }));

app.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const session = await sessionSummary(id, runStatus, runTasks);
  const run = runState(id);
  if (!session && !run) return c.json({ error: 'No such session' }, 404);
  // The task list needs the whole conversation as it reads (up to a rewind); the page may only have loaded its end.
  const tasks = currentTasks((await shownMessages(id)).messages);
  return c.json({ session: session ?? null, run: run ? shownRun(run) : null, tasks, settings: await recordedSettings(id) });
});

app.get('/api/sessions/:id/messages', async (c) => {
  const before = c.req.query('before');
  const limit = Math.min(Number(c.req.query('limit') ?? 120) || 120, 500);
  return c.json(await loadPage(c.req.param('id'), before === undefined ? undefined : Number(before), limit));
});

type SendBody = { text?: string; attachments?: string[]; settings?: RunSettings; uuid?: string; cwd?: string; scratch?: boolean; mode?: SendMode; trust?: TrustChoice };

const permissionMode = (value: unknown) => (isPermissionMode(value) ? value : undefined);

/** The settings a request may carry, and only those, each of its own type. */
function cleanSettings(raw: unknown): RunSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
  const out: RunSettings = {};
  const model = text(value.model, 200);
  const effort = text(value.effort, 20);
  const mode = permissionMode(value.permissionMode);
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (typeof value.fast === 'boolean') out.fast = value.fast;
  if (typeof value.ultracode === 'boolean') out.ultracode = value.ultracode;
  if (mode) out.permissionMode = mode;
  return out;
}

const sendMode = (value: unknown): SendMode | undefined => (value === 'steer' || value === 'queue' ? value : undefined);
const uuidOf = (value: unknown) => (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined);

/** A message body of the right types, or why not: a wrong one is the client's error (400), not ours. */
function sendBody(raw: unknown): SendBody | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Not a message';
  const body = raw as Record<string, unknown>;
  if (body.text !== undefined && typeof body.text !== 'string') return 'The text must be a string';
  if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 50 || !body.attachments.every((a) => typeof a === 'string'))) return 'Attachments must be upload ids';
  if (body.settings !== undefined && (typeof body.settings !== 'object' || body.settings === null)) return 'Settings must be an object';
  if (body.cwd !== undefined && typeof body.cwd !== 'string') return 'The folder must be a path';
  if (body.scratch !== undefined && typeof body.scratch !== 'boolean') return 'scratch must be true or false';
  if (body.trust !== undefined && body.trust !== 'trusted' && body.trust !== 'user-only') return 'trust must be trusted or user-only';
  return body as SendBody;
}

async function attachmentsFrom(ids: string[] | undefined): Promise<Attachment[]> {
  const found = await Promise.all((ids ?? []).map((id) => findUpload(id)));
  return found.filter((a): a is Attachment => Boolean(a));
}

app.post('/api/sessions', async (c) => {
  const body = sendBody(await c.req.json().catch(() => undefined));
  if (typeof body === 'string') return c.json({ error: body }, 400);
  // A scratch session gets its folder only when its first message is sent, so backing out leaves nothing behind.
  const given = body.scratch ? await createScratchFolder() : await checkedFolder(body.cwd);
  if (!given) return c.json({ error: 'No such folder' }, 400);
  // The folder as Claude Code records it, links followed (/tmp is /private/tmp on a Mac): the session's
  // run and its transcript name one folder alike, as its terminals and Changes then do.
  const cwd = await realpath(given).catch(() => given);
  // A folder Pelican made is trusted; any other that nobody trusted is asked about first, every new
  // session, until the answer is to trust it.
  if (body.scratch) await rememberChoice(cwd, 'trusted');
  else if (body.trust) await rememberChoice(cwd, body.trust);
  else {
    const question = await trustQuestion(cwd);
    if (question) return c.json({ error: 'Trust this folder before Claude Code starts in it.', needsTrust: true, brings: question.brings, commands: question.commands, more: question.more }, 409);
  }
  const uuid = uuidOf(body.uuid);
  const sessionId = await sendMessage({ cwd }, {
    text: typeof body.text === 'string' ? body.text : '',
    attachments: await attachmentsFrom(body.attachments),
    settings: cleanSettings(body.settings),
    ...(uuid ? { uuid } : {}),
  });
  // A folder in the temp folder picked for it is no throwaway one: the session is listed, and the
  // folder offered again for new sessions, as a project's are.
  if (!body.scratch) await pickFolder(cwd).catch(() => undefined);
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/messages', async (c) => {
  const body = sendBody(await c.req.json().catch(() => undefined));
  if (typeof body === 'string') return c.json({ error: body }, 400);
  if (body.trust) {
    const folder = getRun(c.req.param('id'))?.cwd ?? (await sessionInfo(c.req.param('id')))?.cwd;
    if (folder && (await isDirectory(folder))) await rememberChoice(folder, body.trust);
  }
  const uuid = uuidOf(body.uuid);
  const mode = sendMode(body.mode);
  const sessionId = await sendMessage({ sessionId: c.req.param('id') }, {
    text: typeof body.text === 'string' ? body.text : '',
    attachments: await attachmentsFrom(body.attachments),
    settings: cleanSettings(body.settings),
    ...(uuid ? { uuid } : {}),
    ...(mode ? { mode } : {}),
  });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/interrupt', async (c) => {
  await getRun(c.req.param('id'))?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/permissions/:requestId', async (c) => {
  const decision = await c.req.json<PermissionDecision>().catch(() => undefined);
  const raw = (decision ?? {}) as Record<string, unknown>;
  const valid = (raw.behavior === 'allow' || raw.behavior === 'deny')
    && (raw.message === undefined || typeof raw.message === 'string')
    && (raw.remember === undefined || typeof raw.remember === 'boolean')
    && (raw.updatedInput === undefined || (typeof raw.updatedInput === 'object' && raw.updatedInput !== null && !Array.isArray(raw.updatedInput)))
    && (raw.permissionMode === undefined || Boolean(permissionMode(raw.permissionMode)));
  if (!decision || !valid) return c.json({ error: 'Not a decision' }, 400);
  const ok = getRun(c.req.param('id'))?.decide(c.req.param('requestId'), decision) ?? false;
  return ok ? c.json({ ok }) : c.json({ error: 'That request is no longer pending' }, 409);
});

/** Model, effort, speed, ultracode or mode changed while Claude runs: it switches at its next step. */
app.post('/api/sessions/:id/settings', async (c) => {
  const body = await c.req.json<{ settings?: unknown }>().catch(() => ({}) as { settings?: unknown });
  if (!body.settings || typeof body.settings !== 'object') return c.json({ error: 'No settings' }, 400);
  await getRun(c.req.param('id'))?.updateSettings(cleanSettings(body.settings));
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/mode', async (c) => {
  const body = await c.req.json<{ permissionMode?: unknown }>();
  const mode = permissionMode(body.permissionMode);
  if (!mode) return c.json({ error: 'No such mode' }, 400);
  await getRun(c.req.param('id'))?.setPermissionMode(mode);
  return c.json({ ok: true });
});

app.patch('/api/sessions/:id', async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: 'Title is empty' }, 400);
  await renameSessionTitle(c.req.param('id'), title.trim());
  return c.json({ ok: true });
});

/**
 * A copy of the session to carry on separately (Fork), as the conversation reads: up to the cut
 * while it is rewound. Fork from here: from a reply (`upTo`), the copy ends at the reply; from a
 * prompt (`before`), it ends just before the prompt, and the prompt's words and files come back
 * for the new session's message box (`prompt`). Nothing comes before the first prompt: no copy is
 * made (`sessionId` null), and the caller starts a new session in the folder with them.
 */
app.post('/api/sessions/:id/fork', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ upTo?: unknown; before?: unknown; title?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
  const { messages } = await shownMessages(id);
  const shown = (uuid: string) => messages.some((m) => m.uuid === uuid);
  if (body.before !== undefined) {
    const before = uuidOf(body.before);
    const file = await transcriptPath(id);
    if (!before || !file || !shown(before)) return c.json({ error: 'That message is not in this conversation.' }, 404);
    // Where the conversation goes back to before the prompt: the entry just before it, as a rewind
    // resumes, none for the conversation's first (a SessionStart hook's context is no conversation).
    const entry = (await entryBefore(file, before))?.entry;
    const prompt = await promptBack(file, before);
    const back = { text: prompt.text, attachments: prompt.attachments };
    return c.json({ sessionId: entry === undefined ? null : await fork(id, entry, title), prompt: back });
  }
  const upTo = body.upTo === undefined ? (await liveCut(id))?.entry : uuidOf(body.upTo);
  if (body.upTo !== undefined && (!upTo || !shown(upTo))) return c.json({ error: 'That message is not in this conversation.' }, 404);
  return c.json({ sessionId: await fork(id, upTo, title) });
});

/**
 * A side question, as Claude Desktop asks one: the session so far is copied into a side chat whose
 * Claude only reads, and the question goes there (runner.ts, startSideChat). The session itself is
 * not touched, also while Claude works in it. Later questions go to the side chat as messages.
 */
app.post('/api/sessions/:id/side', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const body = await c.req.json<{ question?: unknown; settings?: unknown; uuid?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 200_000) return c.json({ error: 'Ask a question' }, 400);
  if (!id || !(await sessionInfo(id))) return c.json({ error: 'No such session' }, 404);
  const uuid = uuidOf(body.uuid);
  const sessionId = await startSideChat(id, { text: body.question, settings: cleanSettings(body.settings), ...(uuid ? { uuid } : {}) });
  return c.json({ sessionId });
});

/**
 * Put a session away from the list, or bring it back; nothing else changes, except that an
 * archived session is no longer pinned.
 */
app.post('/api/sessions/:id/archive', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const body = await c.req.json<{ archived?: unknown }>().catch(() => ({}) as { archived?: unknown });
  if (!id || typeof body.archived !== 'boolean') return c.json({ error: 'Say archived: true or false' }, 400);
  await keep(id, { archived: body.archived });
  sessionsChanged();
  return c.json({ ok: true });
});

/**
 * Keep a session at the top of the list, or let it go back to its place. A pin brings an
 * archived session back (an Undo of archiving a pinned one), since a session is never both.
 */
app.post('/api/sessions/:id/pin', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const body = await c.req.json<{ pinned?: unknown }>().catch(() => ({}) as { pinned?: unknown });
  if (!id || typeof body.pinned !== 'boolean') return c.json({ error: 'Say pinned: true or false' }, 400);
  await keep(id, { pinned: body.pinned });
  sessionsChanged();
  return c.json({ ok: true });
});

app.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (getRun(id)?.busy) return c.json({ error: 'Stop Claude in this session before deleting it.' }, 409);
  getRun(id)?.close();
  await remove(id);
  // The transcript is gone: whether its pin or archive could be let go too is no reason to say it failed.
  await forget(id).catch(() => undefined);
  return c.json({ ok: true });
});

app.get('/api/sessions/:id/export', async (c) => {
  const { title, markdown } = await exportMarkdown(c.req.param('id'));
  const name = `${title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'session'}.md`;
  return c.body(markdown, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
  });
});

app.get('/api/models', async (c) => c.json(await listModels()));

app.get('/api/commands', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ commands: [], agents: [] });
  // A Claude running there knows its list as it is now, and asking it starts nothing.
  const live = await runIn(cwd)?.completions().catch(() => undefined);
  return c.json(live ?? await listCompletions(cwd));
});

/**
 * What a new session in a folder starts with, from Claude Code's settings, and where each value
 * comes from (no folder: a scratch session, and Settings). The demo's are its own, from no file.
 */
app.get('/api/defaults', async (c) => {
  const asked = c.req.query('cwd');
  const cwd = asked ? await checkedFolder(asked) : undefined;
  if (asked && !cwd) return c.json({ error: 'No such folder' }, 404);
  return c.json(await readDefaults(cwd));
});

/** One change, of one kind, as Claude Code's /model, /effort, /fast or /config makes it; or why not. */
function defaultChange(raw: unknown): DefaultChange | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Nothing to change';
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body).filter((key) => key !== 'cwd');
  if (keys.length !== 1) return 'Change one thing at a time';
  if (typeof body.model === 'string') return { model: body.model };
  if (typeof body.fast === 'boolean') return { fast: body.fast };
  if (isPermissionMode(body.permissionMode)) return { permissionMode: body.permissionMode };
  const effort = body.effort as { model?: unknown; level?: unknown } | undefined;
  if (effort && typeof effort === 'object' && typeof effort.model === 'string' && (effort.level === null || isSavedEffort(effort.level))) {
    return { effort: { model: effort.model, level: effort.level } };
  }
  return 'Not a change Pelican makes';
}

/**
 * Changes Claude Code's user settings (CLAUDE_CONFIG_DIR/settings.json) as its own command would,
 * and answers with what a new session in `cwd` starts with now. Never Bypass, never another file.
 */
app.post('/api/defaults', async (c) => {
  const raw = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const change = defaultChange(raw);
  if (typeof change === 'string') return c.json({ error: change }, 400);
  const asked = typeof raw?.cwd === 'string' ? raw.cwd : undefined;
  const cwd = asked ? await checkedFolder(asked) : undefined;
  if (asked && !cwd) return c.json({ error: 'No such folder' }, 404);
  try {
    await saveDefault(change);
  } catch (error) {
    if (error instanceof SettingsRefused) return c.json({ error: error.message }, error.status);
    throw error;
  }
  return c.json(await readDefaults(cwd));
});

/** What `/usage` shows in Claude Code: asked of claude.ai when Settings opens, kept a minute. */
app.get('/api/usage/plan', async (c) => c.json({ plan: await planUsage() }));

app.get('/api/usage', (c) => c.json({
  limits: config.demo
    ? [
      { type: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: Date.now() + 2.4 * 3600_000, at: Date.now() },
      { type: 'seven_day', status: 'allowed', utilization: 0.18, resetsAt: Date.now() + 3.5 * 86400_000, at: Date.now() },
    ]
    : usageLimits(),
}));

/** Titles and folders of sessions, from the session list, for the usage page's lists. */
async function sessionTitles(ids: string[]): Promise<Map<string, { title: string; project: string }>> {
  const wanted = new Set(ids);
  const found = new Map<string, { title: string; project: string }>();
  if (wanted.size === 0) return found;
  for (const s of await listSummaries(runStatus)) if (wanted.has(s.id)) found.set(s.id, { title: s.title, project: s.project });
  return found;
}

/**
 * Usage and activity across every Claude Code session on this computer, whichever app ran it: what
 * has been read so far, and how far reading got. A small home is read before the first answer; a
 * large one fills in as the page asks again.
 */
app.get('/api/usage/stats', async (c) => {
  const asked = c.req.query('range');
  const range: UsageRange = USAGE_RANGES.find((r) => r === asked) ?? '7d';
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([refreshUsage(), new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 1200);
  })]);
  clearTimeout(timer);
  const statsCache = range === 'all' ? await readStatsCache() : undefined;
  return c.json({ summary: await summarize({ range, now: Date.now(), titles: sessionTitles, statsCache }) });
});

/** One session's usage, for its menu: its transcript and its subagents', read now if they changed. */
app.get('/api/sessions/:id/usage', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const file = id ? await transcriptPath(id) : undefined;
  if (!id || !file) return c.json({ usage: null });
  return c.json({ usage: (await sessionUsage(id, await sessionFiles(id, file))) ?? null });
});

/** Whether a path is inside the demo's own folder (the demo never shows anything else). */
async function inDemo(dir: string): Promise<boolean> {
  try {
    const [real, root] = await Promise.all([realpath(dir), realpath(config.home)]);
    return real === root || real.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

/** A folder named in a request: an existing absolute path, and in the demo only the demo's own. */
async function checkedFolder(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd || !path.isAbsolute(cwd) || !(await isDirectory(cwd))) return undefined;
  if (config.demo && !(await inDemo(cwd))) return undefined;
  return cwd;
}

const folderOf = (c: Context) => checkedFolder(c.req.query('cwd'));

/** Whether a folder is in a git repository, by its `.git` and its parents' (this runs nothing). */
async function insideRepository(cwd: string): Promise<boolean> {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (await stat(path.join(dir, '.git')).then(() => true, () => false)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** Git runs only in a trusted folder (trust.ts): a folder you are only shown runs nothing of its own. */
const gitAllowed = (cwd: string) => folderTrusted(cwd);

/** What Changes compares with: the last commit, or (`scope=base`) all of the changes, by Claude Code's /diff. */
const scopeOf = (c: Context) => (c.req.query('scope') === 'base' ? 'base' : 'uncommitted');

app.get('/api/git', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ error: 'No such folder' }, 404);
  if (!(await gitAllowed(cwd))) return c.json(await insideRepository(cwd) ? { repo: false, untrusted: true } : { repo: false });
  return c.json(await gitStatus(cwd, scopeOf(c)));
});

/** One file's diff; `from`, a renamed file's old path, so git pairs the two. */
app.get('/api/git/diff', async (c) => {
  const cwd = await folderOf(c);
  const file = c.req.query('path');
  if (!cwd || !file) return c.json({ error: 'No such file' }, 404);
  if (!(await gitAllowed(cwd))) return c.json({ diff: '' });
  return c.json({ diff: await gitDiff(cwd, file, scopeOf(c), c.req.query('from') || undefined) });
});

/**
 * A pull request Claude named in Desktop's `<pr-created>` tag, as GitHub says it is now: read with
 * gh where it is signed in, for its card; a github.com pull request's address and nothing else.
 */
app.get('/api/pr', async (c) => c.json(await pullRequestStatus(c.req.query('url') ?? '')));

app.get('/api/tree', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ error: 'No such folder' }, 404);
  return c.json({ entries: await listTree(cwd, c.req.query('path') ?? '') });
});

app.get('/api/file', async (c) => {
  const cwd = await folderOf(c);
  const file = c.req.query('path');
  if (!cwd || !file) return c.json({ error: 'No such file' }, 404);
  return c.json(await readProjectFile(cwd, file));
});

/**
 * A file of the folder, downloaded: as an attachment that runs nothing where it opens (no
 * sniffing, the sandbox's policy), read as it is when asked for, up to 200 MB: a file that grows
 * meanwhile sends no more than that. Asked for by a plain link.
 */
app.get('/api/file/raw', async (c) => {
  const cwd = await folderOf(c);
  const file = c.req.query('path');
  if (!cwd || !file) return c.json({ error: 'No such file' }, 404);
  const opened = await openProjectFile(cwd, file).catch(() => undefined);
  if (!opened) return c.json({ error: 'No such file' }, 404);
  if (opened.size > 200 * 1024 * 1024) {
    await opened.handle.close();
    return c.json({ error: 'That file is larger than 200 MB' }, 413);
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(opened.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    'Cache-Control': 'private, no-store',
    ...INERT,
  };
  // HEAD takes this route too and wants no body: a stream nobody reads would hold the file open.
  if (c.req.method === 'HEAD') {
    await opened.handle.close();
    return c.body(null, 200, headers);
  }
  return c.body(exactBytes(opened.handle, 0, opened.size), 200, headers);
});

/**
 * The lines of the folder's files that hold some text (Files' search): Claude Code's own
 * ripgrep, else a bounded scan (search.ts). Runs no git and nothing of the folder's.
 */
app.get('/api/search', async (c) => {
  const cwd = await folderOf(c);
  const q = c.req.query('q') ?? '';
  if (!cwd) return c.json({ error: 'No such folder' }, 404);
  if (!q.trim() || q.length > 200) return c.json({ error: 'Search for some text, up to 200 characters' }, 400);
  return c.json(await searchText(cwd, q));
});

/**
 * Which of the paths named in the conversation are files in the folder (`p`, repeated, at most
 * 50): the links in a reply and in a step open only those. Stats files; runs nothing.
 */
app.get('/api/exists', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ paths: [] });
  const asked = c.req.queries('p') ?? [];
  if (asked.length > EXISTS_MAX) return c.json({ error: `At most ${EXISTS_MAX} paths at a time` }, 400);
  return c.json({ paths: await existingFiles(cwd, asked) });
});

/**
 * What each turn of a session changed (T1, T2…), from Claude Code's records of its edits: no git,
 * so in any folder. With `turn` and `path`, that turn's diff of that file. A side chat changes
 * nothing: the turns it copied of its session are that session's.
 */
app.get('/api/sessions/:id/changes', async (c) => {
  const id = c.req.param('id');
  const file = await transcriptPath(id);
  if (!file) return c.json({ turns: [], lines: {} });
  const cwd = (await sessionInfo(id))?.cwd;
  const ownOnly = await isSideChat(id);
  const turn = c.req.query('turn');
  const target = c.req.query('path');
  if (turn !== undefined || target !== undefined) {
    if (!turn || !target || target.length > 4096) return c.json({ error: 'Which turn and file?' }, 400);
    return c.json({ diff: await turnDiff(file, cwd, turn, target, ownOnly) });
  }
  return c.json(await sessionChanges(file, cwd, ownOnly, (await liveCut(id))?.prompt));
});

/**
 * A `!` command: it starts at once, its output goes to the session's pages as it comes, and once
 * done it goes into the conversation (shell-runs.ts). A folder nobody trusted is asked about
 * before anything runs, as for a message, since recording it starts Claude Code there; the
 * command runs as Claude Code would there, so in a folder kept to the user's settings only, git
 * runs none of the repository's programs.
 */
app.post('/api/sessions/:id/shell', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ command?: unknown; trust?: unknown }>().catch(() => ({}) as { command?: unknown; trust?: unknown });
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return c.json({ error: 'No command' }, 400);
  const cwd = getRun(id)?.cwd ?? (await sessionInfo(id))?.cwd;
  if (!cwd || !(await isDirectory(cwd))) return c.json({ error: 'The session’s folder is missing' }, 404);
  // A side chat reads; it runs nothing in the folder.
  if (await isSideChat(id)) return c.json({ error: 'A side chat runs no commands. Run it in the session itself.' }, 409);
  if (body.trust === 'trusted' || body.trust === 'user-only') await rememberChoice(cwd, body.trust);
  const launch = await launchFor(cwd);
  return c.json({ shell: startShell(id, cwd, command, launch.env) }, 202);
});

/**
 * A folder as terminals name it: its links followed, as a session started there names it (on a
 * Mac, /tmp is /private/tmp), so a terminal opened under one name shows under the other too.
 */
const terminalFolder = async (dir: string): Promise<string> => (path.isAbsolute(dir) ? realpath(dir).catch(() => dir) : dir);

/**
 * Terminals (terminals.ts): those of a folder, the session's (all of them without `cwd`), and
 * whether this Pelican runs any. The first ask loads the PTY. With `folder`, the page's own folder,
 * it says how terminals name that one (TerminalList.folder).
 */
app.get('/api/terminals', async (c) => {
  const ready = await terminalsReady();
  if (!ready.available) return c.json({ ...ready, terminals: [] });
  const cwd = c.req.query('cwd');
  const folder = c.req.query('folder');
  return c.json({
    ...ready,
    terminals: listTerminals(cwd === undefined ? undefined : await terminalFolder(cwd)),
    ...(folder ? { folder: await terminalFolder(folder) } : {}),
  });
});

/**
 * A new terminal: the user's shell in the folder, at the page's size. It runs as Claude Code would
 * there, as a `!` command does: a folder nobody trusted is asked about first (409, needsTrust),
 * and in one kept to the user's settings only, git runs none of the repository's own programs.
 * Not in the demo, nor with --no-terminal (403); 429 when as many run as may.
 */
app.post('/api/terminals', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.cwd !== 'string' || !sizeAllowed(body.cols, body.rows)) return c.json({ error: 'Say where, and the size' }, 400);
  if (body.trust !== undefined && body.trust !== 'trusted' && body.trust !== 'user-only') return c.json({ error: 'trust must be trusted or user-only' }, 400);
  // Run in terminal: only a command whose question showed all of it, as the page reads it.
  if (body.command !== undefined) {
    const refused = typeof body.command === 'string' ? commandRefusal(body.command) : `The command must be some text, up to ${TERMINAL_LIMITS.command} characters`;
    if (refused) return c.json({ error: refused }, 400);
  }
  const colors = body.colors === undefined ? undefined : terminalColors(body.colors);
  if (body.colors !== undefined && !colors) return c.json({ error: 'colors must be a text, a background and a cursor color and 16 more, each #rrggbb' }, 400);
  const ready = await terminalsReady();
  if (!ready.available) return c.json({ error: ready.reason }, terminalsRefused() ? 403 : 503);
  const checked = await checkedFolder(body.cwd);
  if (!checked) return c.json({ error: 'No such folder' }, 404);
  // The folder itself, as the session there names it: one opened on a new session's page, under a
  // link's name, is the session's once it starts.
  const cwd = await terminalFolder(checked);
  if (body.trust) await rememberChoice(cwd, body.trust);
  const launch = await launchFor(cwd);
  try {
    const terminal = await openTerminal(cwd, { cols: body.cols as number, rows: body.rows as number }, {
      ...(launch.env ? { env: launch.env } : {}),
      ...(typeof body.command === 'string' ? { command: body.command } : {}),
      ...(colors ? { colors } : {}),
    });
    return c.json({ terminal }, 201);
  } catch (error) {
    if (error instanceof TooManyTerminals) return c.json({ error: error.message }, 429);
    throw error;
  }
});

/** A terminal, and whether a program runs in it now (a job in the background too): End asks first while one does. */
app.get('/api/terminals/:id', async (c) => {
  const found = await terminalRunning(c.req.param('id'));
  return found ? c.json(found) : c.json({ error: 'No such terminal' }, 404);
});

/** Closes a terminal: its shell is hung up (SIGHUP), as closing a window does, and its pages are told. */
app.delete('/api/terminals/:id', (c) => (closeTerminal(c.req.param('id'))
  ? c.json({ ok: true })
  : c.json({ error: 'No such terminal' }, 404)));

/**
 * An output Claude Code saved in a session's tool-results folder in place of one too long for the
 * conversation, as a long `!` command's record names it: read only, by its name alone, from that
 * session's own folder, a page at a time (`from`, in bytes), for Show all.
 */
app.get('/api/sessions/:id/tool-results/:name', async (c) => {
  const page = await savedOutputPage(c.req.param('id'), c.req.param('name'), Number(c.req.query('from') ?? 0));
  return page ? c.json(page) : c.json({ error: 'That output is no longer saved' }, 404);
});

app.post('/api/sessions/:id/shell/:shell/stop', (c) => (stopShell(c.req.param('id'), c.req.param('shell'))
  ? c.json({ ok: true })
  : c.json({ error: 'That command is not running any more' }, 409)));

const RESTORES: readonly RewindRestore[] = ['both', 'conversation', 'code'];

/**
 * Rewind to here (rewind.ts): back to before the prompt `uuid`, the code, the conversation or both
 * (`restore`), as Claude Code's /rewind and Claude Desktop do; `dryRun` says what it can put back
 * first, for its choices. Not while Claude works (409); while another app has the session open,
 * only the code. It starts the session's Claude, so a folder nobody trusted is asked about first,
 * as for a message (409, needsTrust), and `trust` is the answer.
 */
app.post('/api/sessions/:id/rewind', async (c) => {
  const body = await c.req.json<{ uuid?: unknown; restore?: unknown; dryRun?: unknown; trust?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const uuid = uuidOf(body.uuid);
  if (!uuid) return c.json({ error: 'Which message?' }, 400);
  const restore = RESTORES.find((r) => r === body.restore);
  if (body.dryRun !== true && !restore) return c.json({ error: 'Restore what: both, conversation or code?' }, 400);
  if (body.trust === 'trusted' || body.trust === 'user-only') {
    const folder = getRun(c.req.param('id'))?.cwd ?? (await sessionInfo(c.req.param('id')))?.cwd;
    if (folder && (await isDirectory(folder))) await rememberChoice(folder, body.trust);
  }
  try {
    return c.json(body.dryRun === true ? await checkRewind(c.req.param('id'), uuid) : await rewindTo(c.req.param('id'), uuid, restore!));
  } catch (error) {
    if (error instanceof RewindRefusal) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

/** Undo rewind: the messages the rewind took out come back, until the next message; the files stay as they are. */
app.post('/api/sessions/:id/rewind/undo', async (c) => {
  try {
    await undoRewind(c.req.param('id'));
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof RewindRefusal) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.get('/api/sessions/:id/mcp', async (c) => {
  const id = c.req.param('id');
  const run = getRun(id);
  if (run) return c.json({ servers: await run.mcpServers(), live: true });
  const info = await sessionInfo(id);
  if (!info?.cwd || !(await isDirectory(info.cwd))) return c.json({ servers: [], live: false });
  return c.json({ servers: await probeMcpServers(info.cwd), live: false });
});

app.post('/api/sessions/:id/mcp/:name', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Claude is not running in this session' }, 409);
  const change = await c.req.json<{ enabled?: boolean; reconnect?: boolean }>().catch(() => ({}));
  await run.setMcpServer(c.req.param('name'), change);
  return c.json({ servers: await run.mcpServers() });
});

app.post('/api/sessions/:id/tasks/:task/stop', async (c) => {
  await getRun(c.req.param('id'))?.stopTask(c.req.param('task'));
  return c.json({ ok: true });
});

/** The end of what a background command printed, read while it runs. */
app.get('/api/sessions/:id/tasks/:task/output', async (c) => {
  // The demo's command prints what it would have.
  const demo = config.demo ? demoTaskOutput(c.req.param('id'), c.req.param('task')) : undefined;
  if (demo) return c.json(demo);
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Claude is not running in this session' }, 409);
  return c.json(await run.taskOutput(c.req.param('task')));
});

/** Takes back a prompt waiting for the turn to end, before Claude gets it. */
app.delete('/api/sessions/:id/queued/:uuid', (c) => {
  const ok = getRun(c.req.param('id'))?.unqueue(c.req.param('uuid')) ?? false;
  return ok ? c.json({ ok }) : c.json({ error: 'That message is no longer waiting' }, 409);
});

/**
 * Whether Claude sent this very file in this session (sessions.ts, sentFiles): by its transcript,
 * or by what this Pelican's Claude has just said, which the transcript has a moment later.
 */
async function sentHere(sessionId: string, file: string): Promise<boolean> {
  return (await sentIn(sessionId))(file);
}

/** The same, for many files at once: the transcript is read once. */
async function sentIn(sessionId: string): Promise<(file: string) => boolean> {
  const live = getRun(sessionId)?.delivered;
  const recorded = await sentFiles(sessionId);
  return (file) => Boolean(file) && file.length <= 4096 && path.isAbsolute(file) && (Boolean(live?.has(file)) || recorded.has(file));
}

/** Why a file Claude sent cannot be had, in the words its card says it in. */
const NOT_SENT = 'Not a file Claude sent in this session';
const GONE = 'No longer on this computer';
const TOO_LARGE = 'Larger than Pelican serves (200 MB)';

/** Larger than this, a file Claude sent is not served, as one of the folder's is not. */
const SENT_MAX_BYTES = 200 * 1024 * 1024;

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Videos and sounds a page plays, by extension: those Claude Desktop plays in place. */
const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg',
};

/** A page of a line, in Pelican's colours, that runs nothing and is never framed. */
const NOTE_PAGE = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const notePage = (title: string, line: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${html(title)}</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-content: center; gap: 6px; padding: 24px; box-sizing: border-box; text-align: center; background: #fafafa; color: #555; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif; }
  p { margin: 0; }
  .name { color: #171717; font: 13px/1.5 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #b0b0b0; } .name { color: #ededed; } }
</style>
<p class="name">${html(title)}</p>
<p>${html(line)}</p>
`;

/**
 * A file Claude sent that cannot be had, and why: to the page, as JSON; to a browser that opened it
 * as a page of its own (a PDF's tab, a download it shows), in a page of Pelican's words. Never kept,
 * as the file may come back.
 */
function unavailable(c: Context, status: 404 | 410 | 413, why: string, file?: string): Response {
  if (!/\btext\/html\b/i.test(c.req.header('accept') ?? '')) return c.json({ error: why }, status, { 'Cache-Control': 'no-store' });
  return c.body(notePage(file ? revealHidden(path.basename(file)).text : 'Pelican', why), status, { ...NOTE_PAGE, 'Cache-Control': 'no-store' });
}

/**
 * A file Claude sent in this session, to show: its text (up to half a megabyte), or a picture as
 * data (up to 4 MB), read where Claude Code recorded it, through no link that leads out of its
 * folder. An SVG is text, for its still preview. One no longer there is Gone (410), not missing.
 */
app.get('/api/sessions/:id/sent', async (c) => {
  const file = c.req.query('path') ?? '';
  if (!(await sentHere(c.req.param('id'), file))) return unavailable(c, 404, NOT_SENT);
  try {
    return c.json(await readProjectFile(path.dirname(file), path.basename(file), PICTURE_TYPES));
  } catch {
    return unavailable(c, 410, GONE, file);
  }
});

/** At most this many files Claude sent are asked about at once: one call's. */
const SENT_ASKED_MAX = 50;

/**
 * Whether files Claude sent in this session are still there to have, asked once by their cards
 * before any tap: each is `there`, `gone` (no longer a file where Claude Code delivered it, or a link
 * from there out of its folder), or `large` (past what Pelican serves). A path Claude did not send
 * here is left out. Each file is opened as a download would open it, and nothing is read.
 */
app.get('/api/sessions/:id/sent/state', async (c) => {
  const asked = [...new Set(c.req.queries('p') ?? [])];
  if (asked.length > SENT_ASKED_MAX) return c.json({ error: `Ask about ${SENT_ASKED_MAX} files at most` }, 400);
  const sent = await sentIn(c.req.param('id'));
  const answer: Record<'there' | 'gone' | 'large', string[]> = { there: [], gone: [], large: [] };
  await Promise.all(asked.filter(sent).map(async (file) => {
    const opened = await openProjectFile(path.dirname(file), path.basename(file)).catch(() => undefined);
    await opened?.handle.close();
    answer[!opened ? 'gone' : opened.size > SENT_MAX_BYTES ? 'large' : 'there'].push(file);
  }));
  for (const list of Object.values(answer)) list.sort();
  return c.json(answer);
});

/**
 * A file Claude sent in this session, by a plain link: a picture as itself, for the page to show;
 * a video or a sound to play, a part at a time; a PDF for the browser's own viewer, in a tab of its
 * own; anything else, and anything asked for with `download`, as an attachment. Read only, as it is
 * on disk when asked for (a file that grows meanwhile sends no more), up to 200 MB, never sniffed.
 * One no longer there is Gone (410).
 */
app.get('/api/sessions/:id/sent/raw', async (c) => {
  const file = c.req.query('path') ?? '';
  if (!(await sentHere(c.req.param('id'), file))) return unavailable(c, 404, NOT_SENT);
  const opened = await openProjectFile(path.dirname(file), path.basename(file)).catch(() => undefined);
  if (!opened) return unavailable(c, 410, GONE, file);
  if (opened.size > SENT_MAX_BYTES) {
    await opened.handle.close();
    return unavailable(c, 413, TOO_LARGE, file);
  }
  const name = path.basename(file);
  const ext = path.extname(name).slice(1).toLowerCase();
  const picture = typeOf(PICTURE_TYPES, ext);
  const media = typeOf(MEDIA_TYPES, ext);
  // Saved under the name its card shows: a character that hides or turns text around shown as such.
  const disposition = (how: 'inline' | 'attachment') => `${how}; filename*=UTF-8''${encodeURIComponent(revealHidden(name).text)}`;
  const asked = c.req.query('download') !== undefined ? 'download' : picture ? 'picture' : media ? 'media' : ext === 'pdf' ? 'pdf' : 'download';
  const headers: Record<string, string> = asked === 'picture' && picture
    ? { 'Content-Type': picture, 'Cache-Control': KEPT_ASKING, ...INERT }
    : asked === 'media' && media
      ? { 'Content-Type': media, 'Content-Disposition': disposition('inline'), 'Cache-Control': KEPT_ASKING, 'Accept-Ranges': 'bytes', ...SENT_MEDIA }
      : asked === 'pdf'
        ? { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition('inline'), 'Cache-Control': 'private, no-store', ...SENT_PDF }
        : { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition('attachment'), 'Cache-Control': 'private, no-store', ...INERT };
  let tag: string | undefined;
  if (asked === 'picture' || asked === 'media') {
    // Shown again as the conversation scrolls, or played a part at a time: a browser that has this
    // very version is told so.
    const info = await opened.handle.stat();
    tag = `"${createHash('sha256').update(`${file}\0${info.ino}\0${info.size}\0${info.mtimeMs}`).digest('base64url').slice(0, 27)}"`;
    if (unchanged(c, tag)) {
      await opened.handle.close();
      return c.body(null, 304, { ETag: tag, 'Cache-Control': KEPT_ASKING });
    }
    headers.ETag = tag;
  }
  // A player asks for the part it needs next, of the version it has (If-Range): Safari plays
  // nothing from a server that does not answer so.
  const range = asked === 'media' && (c.req.header('if-range') ?? tag) === tag ? byteRange(c.req.header('range'), opened.size) : undefined;
  if (range === null) {
    await opened.handle.close();
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${opened.size}`, 'Content-Length': '0' });
  }
  const { start, end } = range ?? { start: 0, end: opened.size - 1 };
  headers['Content-Length'] = String(end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${opened.size}`;
  // HEAD takes this route too and wants no body: a stream nobody reads would hold the file open.
  if (c.req.method === 'HEAD') {
    await opened.handle.close();
    return c.body(null, range ? 206 : 200, headers);
  }
  return c.body(exactBytes(opened.handle, start, end - start + 1), range ? 206 : 200, headers);
});

/**
 * The one range of bytes a request asks for (`Range: bytes=…`) in a file of `size` bytes: from a
 * byte on, between two, or the last so many. `undefined` for the whole file (no range, several, or
 * one not written as a range is), `null` for a range the file does not have.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return undefined;
  const [first, last] = [match[1] ? Number(match[1]) : undefined, match[2] ? Number(match[2]) : undefined];
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) return last! > 0 && size > 0 ? { start: Math.max(0, size - last!), end: size - 1 } : null;
  if (last !== undefined && last < first) return undefined;
  return first < size ? { start: first, end: Math.min(last ?? size - 1, size - 1) } : null;
}

/**
 * A page of an Agent call's subagent's own transcript, as a workflow agent's comes: its last
 * messages by default, `before` for earlier ones, `after` for those since (what a card asks while
 * its agent works in the background), each one and the page bounded.
 */
app.get('/api/sessions/:id/agents/:agent', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const position = (name: string) => {
    const value = c.req.query(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
  };
  const before = position('before');
  const after = position('after');
  if (!id || Number.isNaN(before) || Number.isNaN(after) || (before !== undefined && after !== undefined)) return c.json({ error: 'No such agent' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 60) || 60, 1), 300);
  const page = await subagentPage(id, c.req.param('agent'), { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), limit });
  return page ? c.json(page) : c.json({ error: 'No such agent' }, 404);
});

app.get('/api/files', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ files: [] });
  return c.json({ files: await searchFiles(cwd, c.req.query('q') ?? '') });
});

/**
 * Folders to start a new session in: those of recent sessions, without scratch
 * folders, temp folders nobody started a session in here (folders.ts), and
 * folders that are gone. Two folders with the same name are told apart by their
 * parent.
 */
app.get('/api/projects', async (c) => {
  const seen = new Map<string, { path: string; name: string; lastActivity: number; sessions: number }>();
  for (const s of await listSummaries(runStatus)) {
    if (!s.cwd || s.scratch || s.temp) continue;
    const entry = seen.get(s.cwd);
    if (entry) entry.sessions += 1;
    else seen.set(s.cwd, { path: s.cwd, name: s.project, lastActivity: s.lastActivity, sessions: 1 });
  }
  const existing = (await Promise.all([...seen.values()].map(async (p) => ((await isDirectory(p.path)) ? p : undefined))))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const counts = new Map<string, number>();
  for (const p of existing) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  for (const p of existing) {
    if ((counts.get(p.name) ?? 0) > 1) p.name = `${path.basename(path.dirname(p.path))}/${p.name}`;
  }
  return c.json({ projects: existing });
});

app.get('/api/dirs', async (c) => {
  const asked = c.req.query('path');
  if (config.demo && asked && !(await inDemo(asked))) return c.json({ error: 'Not part of the demo' }, 404);
  try {
    return c.json(await listDirs(asked, c.req.query('hidden') === '1'));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

// A new folder to start a session in (the folder browser's New folder). The demo changes nothing.
app.post('/api/dirs', async (c) => {
  const body = await c.req.json<{ parent?: unknown; name?: unknown }>().catch(() => ({}) as { parent?: unknown; name?: unknown });
  if (typeof body.parent !== 'string' || !path.isAbsolute(body.parent) || typeof body.name !== 'string') return c.json({ error: 'Say where, and the name' }, 400);
  try {
    return c.json({ path: await makeDir(body.parent, body.name) });
  } catch (error) {
    if (error instanceof FolderError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.post('/api/uploads', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  return c.json({ attachment: await saveUpload(file) });
});

/** What a file the page loads by address may do: show as itself, nothing more, and only here. */
const INERT = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * A PDF Claude sent, opened in a tab of its own: the browser's PDF viewer shows it, which runs
 * nothing of it as a page of Pelican's, and is never framed. Never sniffed either, so it is never
 * read as a page. No sandbox and no further policy: those keep some browsers' viewers from it.
 */
const SENT_PDF = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * A video or a sound Claude sent, played in the page, or by the browser's own player in a tab of its
 * own: itself, never sniffed, nothing more. That player loads it again from the tab, so the tab keeps
 * Pelican's origin (a sandbox alone makes it none, and the load is refused); with no scripts allowed
 * and nothing else to load, keeping it lets nothing run.
 */
const SENT_MEDIA = { ...INERT, 'Content-Security-Policy': "sandbox allow-same-origin; default-src 'none'; media-src 'self'; frame-ancestors 'self'" };

/**
 * Pictures and files of a conversation: a browser keeps them, but asks the server each time it shows
 * one, so a browser signed out (or whose sign-in was reset) is refused instead of showing its copy.
 * The answer to a browser that has the very one is short: no picture again.
 */
const KEPT_ASKING = 'private, no-cache';
const unchanged = (c: Context, tag: string) => (c.req.header('if-none-match') ?? '').split(',').some((t) => t.trim().replace(/^W\//, '') === tag);

app.get('/api/uploads/:id', async (c) => {
  const upload = await findUpload(c.req.param('id'));
  if (!upload) return c.notFound();
  // An upload never changes under its id.
  const tag = `"${upload.id}"`;
  if (unchanged(c, tag)) return c.body(null, 304, { ETag: tag, 'Cache-Control': KEPT_ASKING });
  const data = await readFile(upload.path).catch(() => undefined);
  if (!data) return c.notFound();
  // Shown in the page only as an image; anything else downloads. Either way it runs nothing:
  // no sniffing, no scripts, no frames.
  const image = upload.mime.startsWith('image/') && upload.mime !== 'image/svg+xml';
  return c.body(new Uint8Array(data), 200, {
    'Content-Type': upload.mime,
    'Cache-Control': KEPT_ASKING,
    ETag: tag,
    ...INERT,
    ...(image ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(upload.name)}` }),
  });
});

/** The picture types Claude takes; nothing else a transcript holds is sent as an image. */
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * A picture a message holds (a screenshot, an image sent with a prompt): pages carry its address
 * instead of the data, so a page of messages stays small and a picture loads only when shown.
 * The same message and position always hold the same picture: its address is its version, so a
 * browser that has it is told so without the transcript being read.
 */
app.get('/api/sessions/:id/images/:uuid/:n', async (c) => {
  const n = Number(c.req.param('n'));
  const file = await transcriptPath(c.req.param('id'));
  if (!file || !Number.isSafeInteger(n)) return c.json({ error: 'No such picture' }, 404);
  const tag = `"${createHash('sha256').update(`${c.req.param('id')}\0${c.req.param('uuid')}\0${n}`).digest('base64url').slice(0, 27)}"`;
  if (unchanged(c, tag)) return c.body(null, 304, { ETag: tag, 'Cache-Control': KEPT_ASKING });
  const image = await transcriptImage(file, c.req.param('uuid'), n);
  if (!image || !PICTURES.has(image.mediaType)) return c.json({ error: 'No such picture' }, 404);
  return c.body(new Uint8Array(image.data), 200, {
    'Content-Type': image.mediaType,
    'Cache-Control': KEPT_ASKING,
    ETag: tag,
    ...INERT,
  });
});

/** What this Pelican's Claude reports of a workflow it runs, by the Workflow call that started it. */
const liveWorkflow = (sessionId: string, call: string) => (config.demo ? demoRunState(sessionId)?.workflows?.[call] : getRun(sessionId)?.workflow(call));

/** A session's Workflow calls, oldest first, with the runs they started. */
app.get('/api/sessions/:id/workflows', async (c) => {
  const id = uuidOf(c.req.param('id'));
  return c.json({ workflows: id ? await workflowCalls(id) : [] });
});

/**
 * One Workflow call's run: its phases and agents and how it stands, as Claude Code reports it,
 * from this Pelican's Claude or from the run's own files (workflows.ts). A page asks again while it
 * runs; an answer it has already comes back short.
 */
app.get('/api/sessions/:id/workflows/:call', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const call = c.req.param('call');
  if (!id || !CALL_ID.test(call)) return c.json({ error: 'No such workflow' }, 404);
  const answer = await workflowView(id, call, liveWorkflow(id, call));
  if (!answer) return c.json({ error: 'No such workflow' }, 404);
  if (unchanged(c, answer.tag)) return c.body(null, 304, { ETag: answer.tag, 'Cache-Control': KEPT_ASKING });
  return c.json({ workflow: answer.workflow }, 200, { ETag: answer.tag, 'Cache-Control': KEPT_ASKING });
});

/**
 * A page of a workflow agent's own transcript: the last messages by default, `before` for earlier
 * ones, `after` for those since (what a page asks while the agent works). An answer the page has
 * already comes back short, as for the run.
 */
app.get('/api/sessions/:id/workflows/:call/agents/:agent', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const call = c.req.param('call');
  const agent = c.req.param('agent');
  const position = (name: string) => {
    const value = c.req.query(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
  };
  const before = position('before');
  const after = position('after');
  if (!id || !CALL_ID.test(call) || !AGENT_ID.test(agent) || Number.isNaN(before) || Number.isNaN(after) || (before !== undefined && after !== undefined)) {
    return c.json({ error: 'No such agent' }, 404);
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 60) || 60, 1), 300);
  const answer = await workflowAgentPage(id, call, agent, { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), limit }, liveWorkflow(id, call));
  if (!answer) return c.json({ error: 'No such agent' }, 404);
  const { tag, ...page } = answer;
  if (unchanged(c, tag)) return c.body(null, 304, { ETag: tag, 'Cache-Control': KEPT_ASKING });
  return c.json(page, 200, { ETag: tag, 'Cache-Control': KEPT_ASKING });
});

app.get('/api/push/key', (c) => c.json({ key: pushKey() ?? null }));

/** A push subscription as browsers make them: an https endpoint, a P-256 key, a 16-byte secret. */
function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const { endpoint, keys } = (value ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const bytes = (text: unknown) => (typeof text === 'string' && /^[\w-]+=*$/.test(text) ? Buffer.from(text, 'base64url').length : -1);
  return typeof endpoint === 'string' && endpoint.length <= 2048 && endpoint.startsWith('https://')
    && bytes(keys?.p256dh) === 65 && bytes(keys?.auth) === 16;
}

const pageUrl = (value: unknown) => typeof value === 'string' && value.length <= 2048 && /^https?:\/\//.test(value);

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json<{ subscription?: unknown; openUrl?: unknown }>().catch(() => ({}) as { subscription?: unknown; openUrl?: unknown });
  if (!validSubscription(body.subscription)) return c.json({ error: 'Not a push subscription' }, 400);
  const { endpoint, keys } = body.subscription;
  await addSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, ...(pageUrl(body.openUrl) ? { openUrl: body.openUrl as string } : {}) });
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: unknown }>().catch(() => ({ endpoint: undefined }));
  if (typeof endpoint !== 'string') return c.json({ error: 'No endpoint' }, 400);
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const ANCESTORS = `frame-ancestors 'self'${config.frameAncestors.map((o) => ` ${o}`).join('')}`;
const FRAMING: Record<string, string> = config.frameAncestors.length === 0 ? { 'X-Frame-Options': 'SAMEORIGIN' } : {};

/** A host name as browsers send it, and nothing that could end a directive. */
const plainHost = (value: string | undefined) => (value && /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/i.test(value) ? value : undefined);

/**
 * The app's own page:
 * - Only Pelican's own origin, and pages the config names, may show it in a frame: any other page
 *   could lay its own buttons over Pelican's and have you approve something (clickjacking).
 * - Scripts only from Pelican, and requests only to Pelican: were something ever to slip HTML into
 *   the page, it could neither run nor send anything (and here a script could run commands).
 * - Images and media come only from Pelican: a picture in Claude's reply, or in a page it wrote,
 *   could otherwise carry what is in the conversation to another server just by loading. A still
 *   preview inherits this, on top of its own policy; the styles and fonts it may load from the
 *   public CDNs are allowed here for that reason only (Preview.tsx).
 */
function pagePolicy(c: Context): string {
  // The page's WebSocket, by the names it reaches Pelican at (older Safari does not count ws: as 'self').
  const hosts = [...new Set([plainHost(c.req.header('host')), plainHost(c.req.header('x-forwarded-host')?.split(',')[0]?.trim())])].filter(Boolean);
  return [
    ANCESTORS,
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${PREVIEW_CDNS}`,
    `font-src 'self' data: https://fonts.gstatic.com ${PREVIEW_CDNS}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${hosts.map((h) => ` ws://${h} wss://${h}`).join('')}`,
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** The document a preview runs in once its scripts may run: the preview policy, as a header that stays. */
const RUNNING_PREVIEW = `${PREVIEW_POLICY}; ${ANCESTORS}`;

/** Compressed copies the build wrote next to each file, best first. */
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']] as const;

/** The encodings a request takes (`Accept-Encoding`), without those it refuses with q=0. */
function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const part of (header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((p) => p.trim());
    const q = params.find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) <= 0)) accepted.add(name);
  }
  return accepted;
}

/** Hashed assets never change under their name: kept in memory once read, each copy by its path. */
const assetCache = new Map<string, Buffer>();

async function readStatic(file: string, hashed: boolean): Promise<Buffer | undefined> {
  const cached = assetCache.get(file);
  if (cached) return cached;
  const data = await readFile(file).catch(() => undefined);
  if (data && hashed) assetCache.set(file, data);
  return data;
}

/** The web app. Every URL in it is relative, so it works under any path a proxy mounts it at. */
app.get('/*', async (c) => {
  if (!config.webDir) return c.text('The web app is not built. Run `npm run build`, or use `npm run dev`.', 503);
  const root = config.webDir;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.text('Bad path', 400);
  }
  // Opening the link Pelican printed (…/?token=…), or the QR code from Settings (…/?code=…),
  // signs this browser in, then drops the secret from the address.
  const token = c.req.query('token');
  const code = c.req.query('code');
  if (token !== undefined || code !== undefined) {
    const url = new URL(c.req.url);
    url.searchParams.delete('token');
    url.searchParams.delete('code');
    url.searchParams.delete('signin');
    const ok = token !== undefined ? checkToken(token) : redeemCode(code);
    // The sign-in page says why a link or a code did not work (it carries no secret), unless this
    // browser is signed in anyway.
    if (!ok && !signedIn(c.req.header('cookie'))) url.searchParams.set('signin', token !== undefined ? 'link' : 'code');
    // Relative to where the page is, so it works under a proxy's path prefix, and can never
    // name another site (`//other.example/` would).
    const location = `./${url.pathname.split('/').pop() ?? ''}${url.search}`;
    if (!ok) return c.body(null, 302, { Location: location, 'Cache-Control': 'no-store' });
    const cookie = newSessionCookie();
    return c.body(null, 302, { Location: location, 'Set-Cookie': cookieHeader(c, cookie.name, cookie.value, cookie.maxAge), 'Cache-Control': 'no-store' });
  }
  const requested = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(root, requested);
  if (!file.startsWith(root) || requested === '/' || !path.extname(file)) file = path.join(root, 'index.html');
  const ext = path.extname(file);
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  const accepted = acceptedEncodings(c.req.header('accept-encoding'));
  let encoding: string | undefined;
  let data: Buffer | undefined;
  for (const [name, suffix] of ENCODINGS) {
    if (!accepted.has(name) && !accepted.has('*')) continue;
    data = await readStatic(`${file}${suffix}`, hashed);
    if (data) {
      encoding = name;
      break;
    }
  }
  data ??= await readStatic(file, hashed);
  if (!data) return c.notFound();
  return c.body(new Uint8Array(data), 200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': file === path.join(root, 'preview.html') ? RUNNING_PREVIEW : pagePolicy(c),
    ...FRAMING,
  });
});

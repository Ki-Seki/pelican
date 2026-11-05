import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import { Readable } from 'node:stream';

import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';

import pkg from '../../package.json' with { type: 'json' };
import { isPermissionMode, START_MODES, startMode } from '../shared/modes.js';
import { PREVIEW_CDNS, PREVIEW_POLICY } from '../shared/preview-policy.js';
import type { Attachment, ChatMessage, PermissionDecision, RunSettings, SendMode, ServerInfo } from '../shared/protocol.js';
import { currentTasks } from '../shared/tasks.js';
import { exportMarkdown, fork, messageBefore, remove } from './actions.js';
import { setArchived } from './archive.js';
import { authMode, beginAttempt, checkPassword, checkToken, cookieName, issueCode, newSessionCookie, proofValid, redeemCode, renewedCookie, signedIn } from './auth.js';
import { config } from './config.js';
import { demoTaskOutput } from './demo.js';
import { sessionsChanged } from './feed.js';
import { findUpload, FolderError, listDirs, makeDir, MAX_UPLOAD_BYTES, removeUpload, saveUpload } from './files.js';
import { claudeCodeInfo, newerClaude } from './claude-code.js';
import { createScratchFolder, isDirectory } from './folders.js';
import { defaultMode, knownModels, listCompletions, listModels, planUsage, probeMcpServers } from './models.js';
import { searchFiles } from './project-files.js';
import { findPhoneAddress } from './phone.js';
import { addSubscription, pushKey, removeSubscription } from './push.js';
import { ensureRun, getRun, replaceLastTurn, runIn, runState, runStatus, runTasks, sendMessage } from './runner.js';
import { startShell, stopShell } from './shell-runs.js';
import { shownRun } from './stream.js';
import { usageLimits } from './usage.js';
import { EXISTS_MAX, existingFiles, gitDiff, gitStatus, listTree, openProjectFile, readProjectFile } from './workspace.js';
import { searchText } from './search.js';
import { sessionChanges, turnDiff } from './changes.js';
import { hostAllowed, isLoopback, originAllowed } from './security.js';
import { listSummaries, loadMessages, loadPage, loadSubagent, recordedSettings, renameSessionTitle, sentFiles, sessionInfo, sessionSummary } from './sessions.js';
import { transcriptImage } from './history.js';
import { instance } from './running.js';
import { rawEntry, rawImages, transcriptPath } from './transcripts.js';
import { folderTrusted, launchFor, NeedsTrust, rememberChoice, type TrustChoice, trustQuestion } from './trust.js';

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

/** What the page loads without fetch, so it cannot mark: an uploaded image, a picture in a message, a download. */
const unmarked = (c: Context) => c.req.method === 'GET'
  && (/^\/api\/uploads\/[^/]+$/.test(c.req.path) || /^\/api\/sessions\/[^/]+\/export$/.test(c.req.path)
    || /^\/api\/sessions\/[^/]+\/images\/[^/]+\/\d+$/.test(c.req.path) || c.req.path === '/api/file/raw');

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

app.onError((error, c) => {
  // Starting Claude Code in a folder nobody trusted: the page asks, then sends again with the answer.
  if (error instanceof NeedsTrust) return c.json({ error: error.message, needsTrust: true, brings: error.brings }, 409);
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

app.post('/api/auth/logout', (c) => {
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
  const info: ServerInfo = { machine: config.machine, home: config.home, version: pkg.version, auth: authMode() !== 'none', demo: config.demo };
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
  // The task list needs the whole conversation; the page may only have loaded its end.
  const tasks = currentTasks(await loadMessages(id));
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
  const cwd = body.scratch ? await createScratchFolder() : await checkedFolder(body.cwd);
  if (!cwd) return c.json({ error: 'No such folder' }, 400);
  // A folder Pelican made is trusted; any other that nobody trusted is asked about first, every new
  // session, until the answer is to trust it.
  if (body.scratch) await rememberChoice(cwd, 'trusted');
  else if (body.trust) await rememberChoice(cwd, body.trust);
  else {
    const question = await trustQuestion(cwd);
    if (question) return c.json({ error: 'Trust this folder before Claude Code starts in it.', needsTrust: true, brings: question.brings }, 409);
  }
  const uuid = uuidOf(body.uuid);
  const sessionId = await sendMessage({ cwd }, {
    text: typeof body.text === 'string' ? body.text : '',
    attachments: await attachmentsFrom(body.attachments),
    settings: cleanSettings(body.settings),
    ...(uuid ? { uuid } : {}),
  });
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

/** Edits made, and being made, by the id the editor gave them: a retry gets the same result, never a second one. */
type Edited = { sessionId: string; inPlace: boolean };
const edits = new Map<string, { at: number } & Edited>();
const editing = new Map<string, Promise<Edited>>();

/** A prompt the user wrote (text or images), not a tool's result or injected context. */
const isPrompt = (m: ChatMessage) => m.role === 'user' && !m.meta && m.blocks.some((b) => b.type === 'text' || b.type === 'image');

/** The images of a prompt, saved as uploads again so the edited prompt carries the ones kept. */
async function imagesOf(sessionId: string, uuid: string, keep: unknown): Promise<Attachment[]> {
  const file = await transcriptPath(sessionId);
  if (!file) return [];
  const images = await rawImages(file, uuid);
  const wanted = Array.isArray(keep) ? new Set(keep.filter((i): i is number => Number.isInteger(i))) : new Set(images.map((_, i) => i));
  const kept: Attachment[] = [];
  for (const [i, image] of images.entries()) {
    if (!wanted.has(i) || image.type !== 'base64' || !image.data) continue;
    const ext = image.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    kept.push(await saveUpload(new File([Buffer.from(image.data, 'base64')], `image-${i + 1}.${ext}`, { type: image.mediaType })));
  }
  return kept;
}

/**
 * Edit a prompt and send it again, as one request.
 * - The last prompt is replaced in place, as rewinding does in Claude Code: the session goes on
 *   from just before it with the new text (the old turn stays in the transcript, off the line).
 * - An earlier one branches: a copy of the conversation up to just before it gets the new text
 *   (the first prompt: a new session in the same folder), and this session stays as it was.
 *   A branch is new work: it never starts in Bypass, but in the mode a new session would.
 * If the send fails, a branch and the copied images are removed, so nothing is left behind.
 */
type EditFailure = { error: string; status: 404 | 409 };

/** Waits until the Claude of a session it just started is running; a start that fails throws. */
async function claudeStarted(sessionId: string): Promise<void> {
  const run = getRun(sessionId);
  if (!run) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([run.ready, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 45_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function makeEdit(id: string, before: string, body: { text: string; settings?: unknown; keepImages?: unknown; startMode?: unknown }, key: string): Promise<Edited | EditFailure> {
  const info = await sessionInfo(id);
  if (!info?.cwd || !(await isDirectory(info.cwd))) return { error: 'The session’s folder is missing', status: 404 };
  if (getRun(id)?.busy) return { error: 'Stop Claude before editing an earlier prompt.', status: 409 };
  const messages = await loadMessages(id);
  const at = messages.findIndex((m) => m.uuid === before);
  if (at < 0) return { error: 'That message is not in this session', status: 404 };
  const previous = at === 0 ? null : messages[at - 1]!.uuid;
  const last = !messages.slice(at + 1).some(isPrompt);
  const file = await transcriptPath(id);
  // In place only for the last prompt, after another one (the first has nothing to go on from),
  // when no background task would be cut off by restarting Claude.
  const entry = last && previous !== null && file && !getRun(id)?.hasBackgroundTasks ? (await rawEntry(file, before))?.parentUuid : undefined;
  const settings = cleanSettings(body.settings);
  if (!entry && settings.permissionMode === 'bypassPermissions') {
    // The mode a new session there starts in: the page's pick in Settings, else Claude Code's own default, else Auto.
    const picked = START_MODES.find((mode) => mode === body.startMode);
    settings.permissionMode = startMode(picked, await defaultMode(info.cwd), knownModels()?.find((m) => m.value === (settings.model ?? 'default')));
  }
  const attachments = await imagesOf(id, before, body.keepImages);
  const message = { text: body.text, attachments, settings, uuid: key };
  let branch: string | undefined;
  let started: string | undefined;
  try {
    if (entry) {
      started = await replaceLastTurn(id, info.cwd, entry, before, message);
      await claudeStarted(started);
      return { sessionId: started, inPlace: true };
    }
    if (previous !== null) branch = await fork(id, previous);
    started = await sendMessage(branch ? { sessionId: branch } : { cwd: info.cwd }, message);
    // Only a Claude that started makes the branch real; one that could not start leaves nothing.
    await claudeStarted(started);
    return { sessionId: started, inPlace: false };
  } catch (error) {
    if (branch) await remove(branch).catch(() => undefined);
    else if (started && !entry) await remove(started).catch(() => undefined);
    await Promise.all(attachments.map((a) => removeUpload(a.id)));
    throw error;
  }
}

/**
 * Edit a prompt and send it again, as one request.
 * - The last prompt is replaced in place, as rewinding does in Claude Code: the session goes on
 *   from just before it with the new text (the old turn stays in the transcript, off the line).
 * - An earlier one branches: a copy of the conversation up to just before it gets the new text
 *   (the first prompt: a new session in the same folder), and this session stays as it was.
 *   A branch is new work: it never starts in Bypass, but in the mode a new session would.
 * If Claude cannot start, a branch and the copied images are removed, so nothing is left behind.
 * Requests with the same `uuid` share one edit, also while it is still being made.
 */
app.post('/api/sessions/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ before?: unknown; text?: unknown; settings?: unknown; uuid?: unknown; keepImages?: unknown; startMode?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const key = uuidOf(body.uuid);
  const before = uuidOf(body.before);
  if (!key || !before || typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'Nothing to send' }, 400);
  for (const [k, v] of edits) if (Date.now() - v.at > 10 * 60_000) edits.delete(k);
  const done = edits.get(key);
  if (done) return c.json({ sessionId: done.sessionId, inPlace: done.inPlace });
  // Registered before anything is awaited, so a second request with this id waits for this one.
  let work = editing.get(key) as Promise<Edited | EditFailure> | undefined;
  if (!work) {
    const made = makeEdit(id, before, { text: body.text, settings: body.settings, keepImages: body.keepImages, startMode: body.startMode }, key);
    work = made;
    editing.set(key, made as Promise<Edited>);
    void made.then((result) => {
      if (!('error' in result)) edits.set(key, { at: Date.now(), ...result });
    }, () => undefined).finally(() => editing.delete(key));
  }
  const result = await work;
  if ('error' in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
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

app.post('/api/sessions/:id/fork', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ upTo?: string; before?: string; title?: string }>().catch(() => ({} as { upTo?: string; before?: string; title?: string }));
  let upTo = body.upTo;
  if (body.before) {
    const previous = await messageBefore(id, body.before);
    if (previous === undefined) return c.json({ error: 'That message is not in this session' }, 404);
    // Nothing comes before the first prompt: the caller starts a new session instead.
    if (previous === null) return c.json({ sessionId: null });
    upTo = previous;
  }
  return c.json({ sessionId: await fork(id, upTo, body.title) });
});

/** Put a session away from the list, or bring it back; nothing else changes. */
app.post('/api/sessions/:id/archive', async (c) => {
  const id = uuidOf(c.req.param('id'));
  const body = await c.req.json<{ archived?: unknown }>().catch(() => ({}) as { archived?: unknown });
  if (!id || typeof body.archived !== 'boolean') return c.json({ error: 'Say archived: true or false' }, 400);
  await setArchived(id, body.archived);
  sessionsChanged();
  return c.json({ ok: true });
});

app.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (getRun(id)?.busy) return c.json({ error: 'Stop Claude in this session before deleting it.' }, 409);
  getRun(id)?.close();
  await remove(id);
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

/** What a new session in a folder starts with, from the user's Claude Code settings (no folder: a scratch session). */
app.get('/api/defaults', async (c) => {
  const asked = c.req.query('cwd');
  const cwd = asked ? await checkedFolder(asked) : undefined;
  if (asked && !cwd) return c.json({ error: 'No such folder' }, 404);
  return c.json({ permissionMode: (await defaultMode(cwd)) ?? null });
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

/** The folder a workspace request is about: the session's own, which must exist. */
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

/** What Changes compares with: the last commit, or (`scope=base`) where the branch split from the default one. */
const scopeOf = (c: Context) => (c.req.query('scope') === 'base' ? 'base' : 'uncommitted');

app.get('/api/git', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ error: 'No such folder' }, 404);
  if (!(await gitAllowed(cwd))) return c.json(await insideRepository(cwd) ? { repo: false, untrusted: true } : { repo: false });
  return c.json(await gitStatus(cwd, scopeOf(c)));
});

app.get('/api/git/diff', async (c) => {
  const cwd = await folderOf(c);
  const file = c.req.query('path');
  if (!cwd || !file) return c.json({ error: 'No such file' }, 404);
  if (!(await gitAllowed(cwd))) return c.json({ diff: '' });
  return c.json({ diff: await gitDiff(cwd, file, scopeOf(c)) });
});

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
 * sniffing, the sandbox's policy), read as it is, up to 200 MB. Asked for by a plain link.
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
  const stream = opened.handle.createReadStream();
  return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(opened.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    'Cache-Control': 'private, no-store',
    ...INERT,
  });
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
 * so in any folder. With `turn` and `path`, that turn's diff of that file.
 */
app.get('/api/sessions/:id/changes', async (c) => {
  const id = c.req.param('id');
  const file = await transcriptPath(id);
  if (!file) return c.json({ turns: [], lines: {} });
  const cwd = (await sessionInfo(id))?.cwd;
  const turn = c.req.query('turn');
  const target = c.req.query('path');
  if (turn !== undefined || target !== undefined) {
    if (!turn || !target || target.length > 4096) return c.json({ error: 'Which turn and file?' }, 400);
    return c.json({ diff: await turnDiff(file, cwd, turn, target) });
  }
  return c.json(await sessionChanges(file, cwd));
});

/**
 * A `!` command: it starts at once, its output goes to the session's pages as it comes, and once
 * done it goes into the conversation (shell-runs.ts). A folder nobody trusted is asked about
 * before anything runs, as for a message, since recording it starts Claude Code there.
 */
app.post('/api/sessions/:id/shell', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ command?: unknown; trust?: unknown }>().catch(() => ({}) as { command?: unknown; trust?: unknown });
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return c.json({ error: 'No command' }, 400);
  const cwd = getRun(id)?.cwd ?? (await sessionInfo(id))?.cwd;
  if (!cwd || !(await isDirectory(cwd))) return c.json({ error: 'The session’s folder is missing' }, 404);
  if (body.trust === 'trusted' || body.trust === 'user-only') await rememberChoice(cwd, body.trust);
  await launchFor(cwd);
  return c.json({ shell: startShell(id, cwd, command) }, 202);
});

app.post('/api/sessions/:id/shell/:shell/stop', (c) => (stopShell(c.req.param('id'), c.req.param('shell'))
  ? c.json({ ok: true })
  : c.json({ error: 'That command is not running any more' }, 409)));

app.post('/api/sessions/:id/rewind', async (c) => {
  const { uuid, dryRun } = await c.req.json<{ uuid?: string; dryRun?: boolean }>().catch(() => ({ uuid: undefined, dryRun: undefined }));
  if (!uuid) return c.json({ error: 'Which prompt?' }, 400);
  const run = await ensureRun(c.req.param('id'));
  if (run.busy) return c.json({ error: 'Stop Claude before rewinding files.' }, 409);
  return c.json(await run.rewind(uuid, dryRun !== false));
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

app.get('/api/sessions/:id/sent', async (c) => {
  const file = c.req.query('path') ?? '';
  if (!file || !(await sentFiles(c.req.param('id'))).has(file)) return c.json({ error: 'Not a file Claude sent in this session' }, 404);
  try {
    return c.json(await readProjectFile(path.dirname(file), path.basename(file)));
  } catch {
    return c.json({ error: 'The file is gone' }, 404);
  }
});

app.get('/api/sessions/:id/agents/:agent', async (c) => {
  return c.json({ messages: await loadSubagent(c.req.param('id'), c.req.param('agent')) });
});

app.get('/api/files', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ files: [] });
  return c.json({ files: await searchFiles(cwd, c.req.query('q') ?? '') });
});

/**
 * Folders to start a new session in: those of recent sessions, without temp
 * and scratch folders and without folders that are gone. Two folders with the
 * same name are told apart by their parent.
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

import { readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import pkg from '../../package.json' with { type: 'json' };
import type { Attachment, PermissionDecision, PermissionMode, RunSettings, SendMode, ServerInfo } from '../shared/protocol.js';
import { currentTasks } from '../shared/tasks.js';
import { exportMarkdown, fork, messageBefore, remove } from './actions.js';
import { authMode, beginAttempt, checkPassword, checkToken, cookieName, issueCode, newSessionCookie, redeemCode, signedIn } from './auth.js';
import { config } from './config.js';
import { findUpload, listDirs, MAX_UPLOAD_BYTES, readUpload, saveUpload } from './files.js';
import { createScratchFolder, isDirectory } from './folders.js';
import { listCompletions, listModels, probeMcpServers } from './models.js';
import { searchFiles } from './project-files.js';
import { addSubscription, pushKey, removeSubscription } from './push.js';
import { ensureRun, getRun, runState, runStatus, sendMessage } from './runner.js';
import { runCommand } from './shell.js';
import { usageLimits } from './usage.js';
import { gitDiff, gitStatus, listTree, readProjectFile } from './workspace.js';
import { hostAllowed, isLoopback, originAllowed } from './security.js';
import { listSummaries, loadMessages, loadPage, loadSubagent, recordedSettings, renameSessionTitle, sentFiles, sessionInfo, sessionSummary } from './sessions.js';

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

/** What the page loads without fetch, so it cannot mark: an uploaded image, a download. */
const unmarked = (c: Context) => c.req.method === 'GET'
  && (/^\/api\/uploads\/[^/]+$/.test(c.req.path) || /^\/api\/sessions\/[^/]+\/export$/.test(c.req.path));

/** The Origin header as an origin (`null`, garbage and missing are none). */
function originOf(header: string | undefined): string | undefined {
  if (!header || header === 'null') return undefined;
  try {
    return new URL(header).origin;
  } catch {
    return undefined;
  }
}

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
  if (!c.req.path.startsWith('/api/auth') && !signedIn(c.req.header('cookie'), c.req.header('authorization'))) {
    return c.json({ error: 'Sign in to continue', signIn: true }, 401);
  }
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

app.onError((error, c) => {
  console.warn('[pelican]', c.req.method, c.req.path, error.message);
  return c.json({ error: error.message }, 500);
});

app.get('/api/auth', (c) => c.json({
  required: authMode() !== 'none',
  mode: authMode(),
  signedIn: signedIn(c.req.header('cookie'), c.req.header('authorization')),
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
  return c.json({ ok: true });
});

/** A one-time code for the QR code that signs a phone in: good once, for two minutes. */
app.post('/api/access/code', (c) => {
  if (authMode() === 'none') return c.json({ code: null });
  return c.json({ code: issueCode() });
});

app.get('/api/info', (c) => {
  const info: ServerInfo = { machine: config.machine, home: config.home, version: pkg.version, auth: authMode() !== 'none', demo: config.demo };
  const key = pushKey();
  if (key) info.pushKey = key;
  return c.json(info);
});

app.get('/api/sessions', async (c) => c.json({ sessions: await listSummaries(runStatus) }));

app.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const session = await sessionSummary(id, runStatus);
  const run = runState(id);
  if (!session && !run) return c.json({ error: 'No such session' }, 404);
  // The task list needs the whole conversation; the page may only have loaded its end.
  const tasks = currentTasks(await loadMessages(id));
  return c.json({ session: session ?? null, run: run ?? null, tasks, settings: await recordedSettings(id) });
});

app.get('/api/sessions/:id/messages', async (c) => {
  const before = c.req.query('before');
  const limit = Math.min(Number(c.req.query('limit') ?? 120) || 120, 500);
  return c.json(await loadPage(c.req.param('id'), before === undefined ? undefined : Number(before), limit));
});

type SendBody = { text?: string; attachments?: string[]; settings?: RunSettings; uuid?: string; cwd?: string; scratch?: boolean; mode?: SendMode };

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const permissionMode = (value: unknown): PermissionMode | undefined =>
  (PERMISSION_MODES as unknown[]).includes(value) ? (value as PermissionMode) : undefined;

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
const uuidOf = (value: unknown) => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);

async function attachmentsFrom(ids: string[] | undefined): Promise<Attachment[]> {
  const found = await Promise.all((ids ?? []).map((id) => findUpload(id)));
  return found.filter((a): a is Attachment => Boolean(a));
}

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<SendBody>();
  // A scratch session gets its folder only when its first message is sent, so backing out leaves nothing behind.
  const cwd = body.scratch ? await createScratchFolder() : await checkedFolder(body.cwd);
  if (!cwd) return c.json({ error: 'No such folder' }, 400);
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
  const body = await c.req.json<SendBody>();
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

/** Edits already made, by the id the editor gave them: a retry gets the same branch, not a second one. */
const edits = new Map<string, { at: number; sessionId: string }>();

/** The images of a prompt, saved as uploads again so the edited prompt carries them too. */
async function imagesOf(sessionId: string, uuid: string, keep: unknown): Promise<Attachment[]> {
  const message = (await loadMessages(sessionId)).find((m) => m.uuid === uuid);
  const images = (message?.blocks ?? []).flatMap((b) => (b.type === 'image' && b.source.type === 'base64' ? [b.source] : []));
  const wanted = Array.isArray(keep) ? new Set(keep.filter((i): i is number => Number.isInteger(i))) : new Set(images.map((_, i) => i));
  const kept: Attachment[] = [];
  for (const [i, image] of images.entries()) {
    if (!wanted.has(i)) continue;
    const ext = image.media_type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    kept.push(await saveUpload(new File([Buffer.from(image.data, 'base64')], `image-${i + 1}.${ext}`, { type: image.media_type })));
  }
  return kept;
}

/**
 * Edit a prompt and send it again, as one request: the conversation branches just before the
 * prompt (the first prompt: a new session in the same folder) and the new text goes there. If
 * the send fails, the branch is removed, so nothing is left behind; this session is untouched.
 */
app.post('/api/sessions/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ before?: unknown; text?: unknown; settings?: unknown; uuid?: unknown; keepImages?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const key = uuidOf(body.uuid);
  const before = uuidOf(body.before);
  if (!key || !before || typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'Nothing to send' }, 400);
  for (const [k, v] of edits) if (Date.now() - v.at > 10 * 60_000) edits.delete(k);
  const done = edits.get(key);
  if (done) return c.json({ sessionId: done.sessionId });
  const info = await sessionInfo(id);
  if (!info?.cwd || !(await isDirectory(info.cwd))) return c.json({ error: 'The session’s folder is missing' }, 404);
  if (getRun(id)?.busy) return c.json({ error: 'Stop Claude before editing an earlier prompt.' }, 409);
  const previous = await messageBefore(id, before);
  if (previous === undefined) return c.json({ error: 'That message is not in this session' }, 404);
  const message = {
    text: body.text,
    attachments: await imagesOf(id, before, body.keepImages),
    settings: cleanSettings(body.settings),
    uuid: key,
  };
  let sessionId: string;
  if (previous === null) {
    sessionId = await sendMessage({ cwd: info.cwd }, message);
  } else {
    const branch = await fork(id, previous);
    try {
      sessionId = await sendMessage({ sessionId: branch }, message);
    } catch (error) {
      await remove(branch).catch(() => undefined);
      throw error;
    }
  }
  edits.set(key, { at: Date.now(), sessionId });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/interrupt', async (c) => {
  await getRun(c.req.param('id'))?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/permissions/:requestId', async (c) => {
  const decision = await c.req.json<PermissionDecision>();
  const asked = (decision as { permissionMode?: unknown }).permissionMode;
  if (asked !== undefined && !permissionMode(asked)) return c.json({ error: 'No such mode' }, 400);
  const ok = getRun(c.req.param('id'))?.decide(c.req.param('requestId'), decision) ?? false;
  return ok ? c.json({ ok }) : c.json({ error: 'That request is no longer pending' }, 409);
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
  return c.json(await listCompletions(cwd));
});

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

app.get('/api/git', async (c) => {
  const cwd = await folderOf(c);
  if (!cwd) return c.json({ error: 'No such folder' }, 404);
  return c.json(await gitStatus(cwd));
});

app.get('/api/git/diff', async (c) => {
  const cwd = await folderOf(c);
  const file = c.req.query('path');
  if (!cwd || !file) return c.json({ error: 'No such file' }, 404);
  return c.json({ diff: await gitDiff(cwd, file) });
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

app.post('/api/sessions/:id/shell', async (c) => {
  const id = c.req.param('id');
  const { command } = await c.req.json<{ command?: string }>().catch(() => ({ command: undefined }));
  if (!command?.trim()) return c.json({ error: 'No command' }, 400);
  const info = await sessionInfo(id);
  if (!info?.cwd || !(await isDirectory(info.cwd))) return c.json({ error: 'The session’s folder is missing' }, 404);
  const result = await runCommand(info.cwd, command.trim());
  // Into the conversation without a turn: Claude reads it with the next message.
  await (await ensureRun(id)).appendShell(result);
  return c.json(result);
});

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

app.post('/api/uploads', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  return c.json({ attachment: await saveUpload(file) });
});

app.get('/api/uploads/:id', async (c) => {
  const found = await readUpload(c.req.param('id'));
  if (!found) return c.notFound();
  // Shown in the page only as an image; anything else downloads. Either way it runs nothing:
  // no sniffing, no scripts, no frames.
  const image = found.attachment.mime.startsWith('image/') && found.attachment.mime !== 'image/svg+xml';
  return c.body(new Uint8Array(found.data), 200, {
    'Content-Type': found.attachment.mime,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
    ...(image ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.attachment.name)}` }),
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

/**
 * - Only Pelican's own origin, and pages the config names, may show it in a frame: any other page
 *   could lay its own buttons over Pelican's and have you approve something (clickjacking).
 * - Images and media come only from Pelican: a picture in Claude's reply, or in a page it wrote,
 *   could otherwise carry what is in the conversation to another server just by loading. The
 *   preview frames inherit this, on top of their own policy (Preview.tsx).
 */
const POLICY: Record<string, string> = {
  'Content-Security-Policy': [
    `frame-ancestors 'self'${config.frameAncestors.map((o) => ` ${o}`).join('')}`,
    "frame-src 'self' blob: data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
  ...(config.frameAncestors.length === 0 ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}),
};

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
    // Relative to where the page is, so it works under a proxy's path prefix, and can never
    // name another site (`//other.example/` would).
    const location = `./${url.pathname.split('/').pop() ?? ''}${url.search}`;
    const ok = token !== undefined ? checkToken(token) : redeemCode(code);
    if (!ok) return c.body(null, 302, { Location: location, 'Cache-Control': 'no-store' });
    const cookie = newSessionCookie();
    return c.body(null, 302, { Location: location, 'Set-Cookie': cookieHeader(c, cookie.name, cookie.value, cookie.maxAge), 'Cache-Control': 'no-store' });
  }
  const requested = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(root, requested);
  if (!file.startsWith(root) || requested === '/' || !path.extname(file)) file = path.join(root, 'index.html');
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...POLICY,
    });
  } catch {
    return c.notFound();
  }
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';

import pkg from '../../package.json' with { type: 'json' };
import type { Attachment, PermissionDecision, RunSettings, SendMode, ServerInfo } from '../shared/protocol.js';
import { currentTasks } from '../shared/tasks.js';
import { exportMarkdown, fork, messageBefore, remove } from './actions.js';
import { allowAttempt, checkPassword, cookieName, newSessionCookie, passwordSet, signedIn } from './auth.js';
import { config } from './config.js';
import { findUpload, listDirs, readUpload, saveUpload } from './files.js';
import { createScratchFolder, isDirectory } from './folders.js';
import { listCompletions, listModels, probeMcpServers } from './models.js';
import { searchFiles } from './project-files.js';
import { addSubscription, pushKey, removeSubscription } from './push.js';
import { ensureRun, getRun, runState, runStatus, sendMessage } from './runner.js';
import { runCommand } from './shell.js';
import { usageLimits } from './usage.js';
import { gitDiff, gitStatus, listTree, readProjectFile } from './workspace.js';
import { hostAllowed, isLoopback, originAllowed } from './security.js';
import { listSummaries, loadMessages, loadPage, loadSubagent, renameSessionTitle, sentFiles, sessionInfo, sessionSummary } from './sessions.js';

export const app = new Hono();

/**
 * Who is asking, for limiting password attempts. The address of the connection,
 * unless that is a proxy on this machine (Tailscale, Caddy, nginx): then the
 * client the proxy added last to X-Forwarded-For. Anyone can write that header,
 * so it is believed only from here, and only its last entry.
 */
function clientAddress(c: Context): string {
  let remote = 'unknown';
  try {
    remote = getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // Not served by Node (tests): one bucket for all.
  }
  const address = remote.replace(/^::ffff:/, '');
  if (isLoopback(address)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return address;
}

const secure = (c: { req: { header: (name: string) => string | undefined; url: string } }) =>
  c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:');

/** Answers only to host names that point at this server, unless a password protects it. */
app.use('*', async (c, next) => {
  if (!passwordSet() && !hostAllowed(c.req.header('host'))) {
    return c.text('This host name is not allowed. Add it to PELICAN_ALLOWED_HOSTS, or set a password with `pelican password`.', 403);
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD'
    && !originAllowed(c.req.header('origin'), c.req.header('host'), c.req.header('x-forwarded-host'))) {
    return c.json({ error: 'Request from another site' }, 403);
  }
  if (!c.req.path.startsWith('/api/auth') && !signedIn(c.req.header('cookie'))) {
    return c.json({ error: 'Sign in to continue', signIn: true }, 401);
  }
  if (config.demo && c.req.method !== 'GET' && !c.req.path.startsWith('/api/auth') && !c.req.path.startsWith('/api/push')) {
    return c.json({ error: 'This is the demo: nothing runs and nothing changes. Start Pelican without --demo to talk to Claude.' }, 403);
  }
  await next();
});

app.onError((error, c) => {
  console.warn('[pelican]', c.req.method, c.req.path, error.message);
  return c.json({ error: error.message }, 500);
});

app.get('/api/auth', (c) => c.json({ required: passwordSet(), signedIn: signedIn(c.req.header('cookie')) }));

app.post('/api/auth/login', async (c) => {
  if (!allowAttempt(clientAddress(c))) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!passwordSet() || typeof password !== 'string' || !(await checkPassword(password))) {
    return c.json({ error: 'Wrong password' }, 401);
  }
  const cookie = newSessionCookie();
  c.header('Set-Cookie', `${cookie.name}=${cookie.value}; Path=/; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=Lax${secure(c) ? '; Secure' : ''}`);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', `${cookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(c) ? '; Secure' : ''}`);
  return c.json({ ok: true });
});

app.get('/api/info', (c) => {
  const info: ServerInfo = { machine: config.machine, home: config.home, version: pkg.version, auth: passwordSet(), demo: config.demo };
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
  return c.json({ session: session ?? null, run: run ?? null, tasks });
});

app.get('/api/sessions/:id/messages', async (c) => {
  const before = c.req.query('before');
  const limit = Math.min(Number(c.req.query('limit') ?? 120) || 120, 500);
  return c.json(await loadPage(c.req.param('id'), before === undefined ? undefined : Number(before), limit));
});

type SendBody = { text?: string; attachments?: string[]; settings?: RunSettings; uuid?: string; cwd?: string; scratch?: boolean; mode?: SendMode };

async function attachmentsFrom(ids: string[] | undefined): Promise<Attachment[]> {
  const found = await Promise.all((ids ?? []).map((id) => findUpload(id)));
  return found.filter((a): a is Attachment => Boolean(a));
}

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<SendBody>();
  // A scratch session gets its folder only when its first message is sent, so backing out leaves nothing behind.
  const cwd = body.scratch ? await createScratchFolder() : body.cwd;
  const sessionId = await sendMessage({ cwd }, {
    text: body.text ?? '',
    attachments: await attachmentsFrom(body.attachments),
    settings: body.settings ?? {},
    ...(body.uuid ? { uuid: body.uuid } : {}),
  });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/messages', async (c) => {
  const body = await c.req.json<SendBody>();
  const sessionId = await sendMessage({ sessionId: c.req.param('id') }, {
    text: body.text ?? '',
    attachments: await attachmentsFrom(body.attachments),
    settings: body.settings ?? {},
    ...(body.uuid ? { uuid: body.uuid } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
  });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/interrupt', async (c) => {
  await getRun(c.req.param('id'))?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/permissions/:requestId', async (c) => {
  const decision = await c.req.json<PermissionDecision>();
  const ok = getRun(c.req.param('id'))?.decide(c.req.param('requestId'), decision) ?? false;
  return ok ? c.json({ ok }) : c.json({ error: 'That request is no longer pending' }, 409);
});

app.post('/api/sessions/:id/mode', async (c) => {
  const { permissionMode } = await c.req.json<{ permissionMode: RunSettings['permissionMode'] }>();
  await getRun(c.req.param('id'))?.setPermissionMode(permissionMode);
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
  });
});

app.get('/api/models', async (c) => c.json(await listModels()));

app.get('/api/commands', async (c) => {
  const cwd = c.req.query('cwd');
  if (!cwd || !(await isDirectory(cwd))) return c.json({ commands: [], agents: [] });
  return c.json(await listCompletions(cwd));
});

app.get('/api/qr', async (c) => {
  const text = c.req.query('text') ?? '';
  if (!text || text.length > 512) return c.json({ error: 'Nothing to encode' }, 400);
  const { qrSvg } = await import('./qr.js');
  return c.body(qrSvg(text), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' });
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
async function folderOf(c: Context): Promise<string | undefined> {
  const cwd = c.req.query('cwd');
  return cwd && (await isDirectory(cwd)) ? cwd : undefined;
}

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
  const cwd = c.req.query('cwd');
  if (!cwd || !(await isDirectory(cwd))) return c.json({ files: [] });
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
  try {
    return c.json(await listDirs(c.req.query('path'), c.req.query('hidden') === '1'));
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
  return c.body(new Uint8Array(found.data), 200, {
    'Content-Type': found.attachment.mime,
    'Cache-Control': 'private, max-age=86400',
  });
});

app.get('/api/push/key', (c) => c.json({ key: pushKey() ?? null }));

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json<{ subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; openUrl?: string }>();
  await addSubscription({ ...body.subscription, ...(body.openUrl ? { openUrl: body.openUrl } : {}) });
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint: string }>();
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
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
    });
  } catch {
    return c.notFound();
  }
});

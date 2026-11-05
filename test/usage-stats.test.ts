import { appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { distinctLimits, flushUsage, noteRunStatus, period, readStatsCache, refreshUsage, resetUsage, sessionFiles, sessionUsage, streaks, summarize } from '../src/server/stats';

// Every test writes its own transcripts into the temporary Claude Code home test/setup.ts made.
const projects = () => path.join(config.claudeHome, 'projects');
const NOW = Date.parse('2026-11-05T18:00:00.000Z');
const at = (iso: string) => new Date(Date.parse(iso)).toISOString();

const MAIN = '11111111-1111-4111-8111-111111111111';
const SIDE = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

type Usage = { input?: number; output?: number; read?: number; write?: number; write1h?: number };
const usage = (u: Usage) => ({
  input_tokens: u.input ?? 0,
  output_tokens: u.output ?? 0,
  cache_read_input_tokens: u.read ?? 0,
  cache_creation_input_tokens: u.write ?? 0,
  ...(u.write1h ? { cache_creation: { ephemeral_5m_input_tokens: (u.write ?? 0) - u.write1h, ephemeral_1h_input_tokens: u.write1h } } : {}),
});

/** A reply as Claude Code writes it: one row per content block, each with the reply's whole usage. */
function reply(session: string, id: string, time: string, u: Usage, extra: Record<string, unknown> = {}, blocks = 1): string[] {
  return Array.from({ length: blocks }, (_, i) => JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: i === 0 ? 'thinking' : 'text', text: 'x' }], usage: usage(u) },
    requestId: `req_${id}`,
    type: 'assistant',
    uuid: `${id}-${i}`,
    timestamp: at(time),
    entrypoint: 'cli',
    cwd: '/work/app',
    sessionId: session,
    ...extra,
  }));
}

const prompt = (session: string, time: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Do it' }, uuid: `u-${time}`, timestamp: at(time),
  entrypoint: 'cli', cwd: '/work/app', sessionId: session, ...extra,
});

const toolResult = (session: string, time: string, size = 100) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(size) }] },
  uuid: `r-${time}`, timestamp: at(time), sessionId: session, toolUseResult: { stdout: 'y' },
});

const compaction = (session: string, time: string) => JSON.stringify({
  parentUuid: null, logicalParentUuid: 'x', isSidechain: false, type: 'system', subtype: 'compact_boundary',
  compactMetadata: { trigger: 'auto', preTokens: 180000 }, uuid: `c-${time}`, timestamp: at(time), sessionId: session,
});

const limitHit = (session: string, time: string, text: string) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'assistant', uuid: `l-${time}`, timestamp: at(time), sessionId: session,
  message: { id: `synthetic-${time}`, model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }] },
  isApiErrorMessage: true, error: 'rate_limit',
});

const costState = (session: string, usd: number, startTime: number, modelUsage: Record<string, Record<string, number>>) => JSON.stringify({
  type: 'cost-state', sessionId: session, totalCostUSD: usd, startTime, totalDuration: 60_000, modelUsage, hasUnknownModelCost: false,
});

async function transcript(file: string, lines: string[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

const mainFile = (id: string, project = '-work-app') => path.join(projects(), project, `${id}.jsonl`);
const titles = async (ids: string[]) => new Map(ids.map((id) => [id, { title: `Session ${id.slice(0, 4)}`, project: 'app' }]));
const sum = (range: '7d' | '30d' | 'all' = '7d', statsCache?: Awaited<ReturnType<typeof readStatsCache>>) => summarize({ range, now: NOW, titles, statsCache });

beforeEach(async () => {
  resetUsage();
  await rm(config.claudeHome, { recursive: true, force: true });
  await rm(config.stateDir, { recursive: true, force: true });
});

describe('usage from transcripts', () => {
  it('counts each reply once, by kind, though Claude Code writes one row per content block', async () => {
    await transcript(mainFile(MAIN), [
      prompt(MAIN, '2026-11-05T10:00:00Z'),
      ...reply(MAIN, 'msg_a', '2026-11-05T10:00:05Z', { input: 10, output: 200, read: 5000, write: 1000, write1h: 400 }, {}, 3),
      toolResult(MAIN, '2026-11-05T10:00:06Z'),
      ...reply(MAIN, 'msg_b', '2026-11-05T10:01:00Z', { input: 2, output: 50, read: 6000 }, {}, 2),
    ]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.tokens).toEqual({ input: 12, output: 250, cacheRead: 11000, cacheWrite: 1000 });
    expect(s.models).toEqual([{ model: 'claude-opus-5-5', name: 'Opus 5.5', tokens: 12262 }]);
    expect(s.sessions).toMatchObject([{ id: MAIN, title: 'Session 1111', tokens: 12262, app: 'Terminal' }]);
    expect(s.activity).toMatchObject({ sessions: 1, activeDays: 1, days: 7, currentStreak: 1, longestStreak: 1, longest: { id: MAIN, ms: 60_000 } });
    expect(s.progress).toEqual({ files: 1, read: 1, ready: true });
  });

  it('adds subagents, in the transcript and in files of their own, to their session’s tokens but not as sessions', async () => {
    await transcript(mainFile(MAIN), [
      prompt(MAIN, '2026-11-05T10:00:00Z'),
      ...reply(MAIN, 'msg_main', '2026-11-05T10:00:05Z', { output: 100 }),
      // An older Claude Code kept a subagent's rows in the session's own transcript.
      ...reply(MAIN, 'msg_side', '2026-11-05T12:00:00Z', { output: 40 }, { isSidechain: true }),
    ]);
    await transcript(path.join(projects(), '-work-app', MAIN, 'subagents', 'agent-a1.jsonl'), [
      ...reply(MAIN, 'msg_agent', '2026-11-05T10:00:30Z', { output: 7, read: 300 }, { isSidechain: true }),
    ]);
    await transcript(path.join(projects(), '-work-app', MAIN, 'subagents', 'workflows', 'wf_1', 'agent-b2.jsonl'), [
      ...reply(MAIN, 'msg_wf', '2026-11-05T10:00:40Z', { output: 3 }, { isSidechain: true }),
    ]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.tokens.output).toBe(150);
    expect(s.tokens.cacheRead).toBe(300);
    expect(s.activity.sessions).toBe(1);
    // The subagent row at 12:00 is not the session's own: it lasted from 10:00:00 to 10:00:05.
    expect(s.activity.longest).toEqual({ id: MAIN, title: 'Session 1111', ms: 5000, at: Date.parse('2026-11-05T10:00:00Z') });
    expect(s.progress.files).toBe(3);
    const files = await sessionFiles(MAIN, mainFile(MAIN));
    expect(files.map((f) => path.basename(f.file)).sort()).toEqual([`${MAIN}.jsonl`, 'agent-a1.jsonl', 'agent-b2.jsonl']);
    expect((await sessionUsage(MAIN, files))?.tokens.output).toBe(150);
  });

  it('counts a conversation copied into a side chat, a fork or a branch once, for the session it ran in', async () => {
    const original = [
      prompt(MAIN, '2026-11-04T09:00:00Z'),
      ...reply(MAIN, 'msg_1', '2026-11-04T09:00:05Z', { output: 100, read: 1000 }),
      ...reply(MAIN, 'msg_2', '2026-11-04T09:01:00Z', { output: 100, read: 1000 }),
    ];
    await transcript(mainFile(MAIN), original);
    // A side chat starts with the conversation as it was, rows and session id unchanged…
    await transcript(mainFile(SIDE), [...original, prompt(SIDE, '2026-11-05T09:00:00Z'), ...reply(SIDE, 'msg_s', '2026-11-05T09:00:03Z', { output: 5 })]);
    // …a fork marks its copies, and a branch rewrites their session id but keeps each reply's id.
    await transcript(mainFile(OTHER), [
      ...reply(OTHER, 'msg_1', '2026-11-04T09:00:05Z', { output: 100, read: 1000 }, { forkedFrom: { sessionId: MAIN, messageUuid: 'x' } }),
      ...reply(OTHER, 'msg_f', '2026-11-05T11:00:00Z', { output: 9 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await transcript(mainFile(BRANCH), [
      ...original.map((line) => line.replaceAll(MAIN, BRANCH)),
      ...reply(BRANCH, 'msg_b', '2026-11-05T10:00:00Z', { output: 7 }),
    ]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.tokens.output).toBe(200 + 5 + 9 + 7);
    const byId = Object.fromEntries(s.sessions.map((x) => [x.id, x.tokens]));
    expect(byId[MAIN]).toBe(2200);
    expect(byId[SIDE]).toBe(5);
    expect(byId[OTHER]).toBe(9);
    expect(byId[BRANCH]).toBe(7);
    // A side chat that only copied would not count as a session started: its own rows start the next day.
    expect(s.activity.sessions).toBe(4);
  });

  it('counts compactions of the conversation itself, and lists sessions compacted three times or more', async () => {
    await transcript(mainFile(MAIN), [
      prompt(MAIN, '2026-11-05T08:00:00Z'),
      ...reply(MAIN, 'msg_1', '2026-11-05T08:00:05Z', { output: 1 }),
      compaction(MAIN, '2026-11-05T09:00:00Z'),
      compaction(MAIN, '2026-11-05T10:00:00Z'),
      // A subagent's compaction is its own context's, not the session's.
      compaction(MAIN, '2026-11-05T10:30:00Z').replace('"isSidechain":false', '"isSidechain":true'),
      compaction(MAIN, '2026-11-05T11:00:00Z'),
    ]);
    await transcript(mainFile(OTHER), [prompt(OTHER, '2026-11-05T08:00:00Z'), ...reply(OTHER, 'msg_o', '2026-11-05T08:00:05Z', { output: 1 }), compaction(OTHER, '2026-11-05T09:00:00Z')]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.compacted).toEqual([{ id: MAIN, title: 'Session 1111', times: 3 }]);
    expect((await sessionUsage(MAIN, await sessionFiles(MAIN, mainFile(MAIN))))?.compactions).toBe(3);
  });

  it('notes the usage limits reached, each once per window, and passes over tools’ output and pictures', async () => {
    await transcript(mainFile(MAIN), [
      prompt(MAIN, '2026-11-03T13:00:00Z'),
      ...reply(MAIN, 'msg_1', '2026-11-03T13:00:05Z', { output: 1 }),
      toolResult(MAIN, '2026-11-03T13:00:06Z', 400 * 1024),
      limitHit(MAIN, '2026-11-03T14:10:00Z', 'You’ve hit your 5-hour limit · resets 3pm'),
      limitHit(MAIN, '2026-11-03T14:40:00Z', "You've hit your limit · resets 3pm (Europe/London)"),
      limitHit(MAIN, '2026-11-04T16:00:00Z', "You've hit your session limit · resets 8pm"),
      limitHit(MAIN, '2026-11-05T09:00:00Z', "You've hit your weekly limit · resets Nov 9"),
      limitHit(MAIN, '2026-11-05T09:30:00Z', "You've hit your monthly spend limit."),
    ]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.limits).toEqual([
      { kind: 'session', at: Date.parse('2026-11-03T14:10:00Z') },
      { kind: 'session', at: Date.parse('2026-11-04T16:00:00Z') },
      { kind: 'weekly', at: Date.parse('2026-11-05T09:00:00Z') },
    ]);
    expect(s.tokens.output).toBe(1);
  });

  it('prices replies with Claude Code’s own estimates on this computer, and says which sessions have none', async () => {
    await transcript(mainFile(MAIN), [
      prompt(MAIN, '2026-11-05T10:00:00Z'),
      ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { input: 1000, output: 1000 }),
      // Claude Code's estimate for this session: $0.03 for 1,000 in and 1,000 out, so $0.000005 a weighted token.
      costState(MAIN, 0.03, Date.parse('2026-11-05T10:00:00Z'), { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.03, webSearchRequests: 0 } }),
    ]);
    await transcript(mainFile(OTHER), [
      prompt(OTHER, '2026-11-05T11:00:00Z'),
      ...reply(OTHER, 'msg_2', '2026-11-05T11:00:05Z', { input: 2000, output: 0 }),
      ...reply(OTHER, 'msg_3', '2026-11-05T11:01:05Z', { output: 10 }, { message: { model: 'claude-unknown-1', id: 'msg_3', role: 'assistant', usage: usage({ output: 10 }) } }),
    ]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.cost?.usd).toBeCloseTo(0.03 + 2000 * 0.000005, 6);
    expect(s.cost?.without).toBe(1);
    expect((await sessionUsage(MAIN, await sessionFiles(MAIN, mainFile(MAIN))))?.cost?.usd).toBeCloseTo(0.03, 6);
    // A session with a model nothing priced has no figure at all, rather than a part of one.
    expect((await sessionUsage(OTHER, await sessionFiles(OTHER, mainFile(OTHER))))?.cost).toBeUndefined();
  });

  it('tells a model’s price of a cache read from its price of input, once its sessions differ enough', async () => {
    // Claude Code priced these at $4 a million input tokens and $0.20 a million cache reads.
    const opus = (input: number, read: number) => ({ 'claude-opus-5-5': { inputTokens: input, outputTokens: 0, cacheReadInputTokens: read, cacheCreationInputTokens: 0, costUSD: input * 4e-6 + read * 2e-7, webSearchRequests: 0 } });
    const start = Date.parse('2026-11-05T09:00:00Z');
    await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { read: 1_000_000 }), costState(MAIN, 0.024, start, opus(1000, 100_000))]);
    await transcript(mainFile(OTHER), [prompt(OTHER, '2026-11-05T11:00:00Z'), costState(OTHER, 0.028, start, opus(6000, 20_000))]);
    await refreshUsage(0);
    // A million cache reads at $0.20, where a tenth of the input price would have said $0.40.
    expect((await sum()).cost?.usd).toBeCloseTo(0.2, 6);
  });

  it('breaks usage down by project and by app, Pelican’s own sessions included', async () => {
    await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 30 }, { entrypoint: 'claude-desktop' })]);
    await transcript(mainFile(OTHER, '-work-site'), [
      prompt(OTHER, '2026-11-05T11:00:00Z', { cwd: '/work/site' }),
      ...reply(OTHER, 'msg_2', '2026-11-05T11:00:05Z', { output: 20 }, { entrypoint: 'sdk-ts', cwd: '/work/site' }),
      ...reply(OTHER, 'msg_3', '2026-11-05T11:05:05Z', { output: 10 }, { entrypoint: 'cli', cwd: '/work/site' }),
    ]);
    noteRunStatus(OTHER, 'running', NOW);
    await refreshUsage(0);
    const s = await sum();
    expect(s.projects.map((p) => [p.name, p.tokens, p.sessions])).toEqual([['app', 30, 1], ['site', 30, 1]]);
    expect(s.apps).toEqual([{ app: 'Claude Desktop', tokens: 30, sessions: 1 }, { app: 'Pelican', tokens: 20, sessions: 1 }, { app: 'Terminal', tokens: 10, sessions: 1 }]);
  });

  it('adds up how long Claude waited for an answer in sessions Pelican ran', async () => {
    noteRunStatus(MAIN, 'running', NOW - 60_000);
    noteRunStatus(MAIN, 'waiting', NOW - 50_000);
    noteRunStatus(MAIN, 'waiting', NOW - 40_000);
    noteRunStatus(MAIN, 'running', NOW - 20_000);
    noteRunStatus(MAIN, 'waiting', NOW - 10_000);
    noteRunStatus(MAIN, 'idle', NOW - 5_000);
    await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T17:58:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T17:58:05Z', { output: 1 })]);
    await refreshUsage(0);
    const s = await sum();
    expect(s.waits).toEqual({ ms: 35_000, count: 2, longest: 30_000 });
    expect((await sessionUsage(MAIN, await sessionFiles(MAIN, mainFile(MAIN))))?.waits).toEqual({ ms: 35_000, count: 2 });
  });

  it('lets Claude Code’s own stats count the days it counted, for everything only', async () => {
    await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-04T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-04T10:00:05Z', { output: 1 })]);
    await transcript(mainFile(OTHER), [prompt(OTHER, '2026-11-05T10:00:00Z'), ...reply(OTHER, 'msg_2', '2026-11-05T12:00:05Z', { output: 1 })]);
    await writeFile(path.join(config.claudeHome, 'stats-cache.json'), JSON.stringify({
      version: 5,
      lastComputedDate: '2026-11-04',
      dailyActivity: [
        { date: '2026-10-01', messageCount: 40, sessionCount: 2, toolCallCount: 9 },
        { date: '2026-10-02', messageCount: 12, sessionCount: 1, toolCallCount: 2 },
        { date: '2026-11-04', messageCount: 30, sessionCount: 3, toolCallCount: 4 },
      ],
      dailyModelTokens: [],
      modelUsage: {},
      totalSessions: 6,
      totalMessages: 82,
      longestSession: { sessionId: 'old', duration: 9_000_000, messageCount: 50, timestamp: '2026-10-01T08:00:00.000Z' },
      firstSessionDate: '2026-10-01T08:00:00.000Z',
      hourCounts: {},
    }));
    await refreshUsage(0);
    const cache = await readStatsCache();
    const all = await sum('all', cache);
    expect(all.from).toBe('2026-10-01');
    expect(all.activity).toMatchObject({ sessions: 2 + 1 + 3 + 1, activeDays: 4, longestStreak: 2, currentStreak: 2, longest: { id: 'old', ms: 9_000_000, at: Date.parse('2026-10-01') } });
    expect(all.activity.since).toBe('2026-10-01');
    // Tokens come from the transcripts alone: the first one is from November 4.
    expect(all.tokensSince).toBe('2026-11-04');
    expect(all.series.unit).toBe('day');
    const week = await sum('7d', cache);
    expect(week.activity).toMatchObject({ sessions: 2, activeDays: 2 });
  });
});

describe('the cache of what was read', () => {
  it('reads a transcript again only when it changed, and then only what was added', async () => {
    const file = await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 10 }, {}, 2)]);
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(10);
    // A reply's last block and a new reply, appended while Claude writes; the last line not finished yet.
    const next = reply(MAIN, 'msg_2', '2026-11-05T10:02:00Z', { output: 5 });
    await appendFile(file, `${reply(MAIN, 'msg_1', '2026-11-05T10:00:06Z', { output: 12 })[0]}\n${next[0]!.slice(0, 30)}`);
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(12);
    await appendFile(file, `${next[0]!.slice(30)}\n`);
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(17);
    // Unchanged: nothing is read.
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(17);
  });

  it('reads a transcript afresh when it was rewritten, shorter or changed before where reading stopped', async () => {
    const file = await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 10 })]);
    await refreshUsage(0);
    await transcript(file, [prompt(MAIN, '2026-11-05T10:00:00Z')]);
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(0);
    // The same size and a later time, other bytes: not an append.
    await transcript(file, [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 10 })]);
    await refreshUsage(0);
    const before = (await sum()).tokens.output;
    await transcript(file, [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_9', '2026-11-05T10:00:05Z', { output: 70 })]);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await refreshUsage(0);
    expect(before).toBe(10);
    expect((await sum()).tokens.output).toBe(70);
  });

  it('keeps what it read in the state folder, so a restart reads nothing again', async () => {
    const file = await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 10, read: 99 })]);
    // A time to the millisecond, which setting it again gives back exactly.
    const when = new Date('2026-11-05T10:00:10.000Z');
    await utimes(file, when, when);
    await refreshUsage(0);
    const first = await sum();
    await flushUsage();
    resetUsage();
    // The transcript changes under the same size and time: only reading it again would see that.
    await writeFile(file, (await readFile(file, 'utf8')).replace('"output_tokens":10', '"output_tokens":20'));
    await utimes(file, when, when);
    await refreshUsage(0);
    expect((await sum()).tokens).toEqual(first.tokens);
    // A record of another version is read again.
    await flushUsage();
    resetUsage();
    const { RECORD_VERSION } = await import('../src/server/stats');
    const shards = path.join(config.stateDir, 'usage', 'files');
    for (const name of await (await import('node:fs/promises')).readdir(shards)) {
      const shard = path.join(shards, name);
      await writeFile(shard, (await readFile(shard, 'utf8')).replaceAll(`"v":${RECORD_VERSION}`, `"v":${RECORD_VERSION + 100}`));
    }
    await refreshUsage(0);
    expect((await sum()).tokens.output).toBe(20);
  });

  it('forgets a transcript that is gone', async () => {
    const file = await transcript(mainFile(MAIN), [prompt(MAIN, '2026-11-05T10:00:00Z'), ...reply(MAIN, 'msg_1', '2026-11-05T10:00:05Z', { output: 10 })]);
    await refreshUsage(0);
    await rm(file);
    await refreshUsage(0);
    const s = await sum();
    expect(s.tokens.output).toBe(0);
    expect(s.activity.sessions).toBe(0);
  });
});

describe('the figures', () => {
  it('counts streaks as /stats does: the current one ends today', () => {
    expect(streaks(new Set([1, 2, 3, 5, 6]), 0, 6)).toEqual({ current: 2, longest: 3 });
    expect(streaks(new Set([1, 2, 3]), 0, 6)).toEqual({ current: 0, longest: 3 });
  });

  it('covers the last 7 or 30 UTC days, or everything since the first day known', () => {
    const today = Math.floor(NOW / 86_400_000);
    expect(period('7d', NOW, undefined)).toEqual({ from: today - 6, to: today });
    expect(period('30d', NOW, undefined)).toEqual({ from: today - 29, to: today });
    expect(period('all', NOW, today - 100)).toEqual({ from: today - 100, to: today });
  });

  it('counts a limit once while it lasts', () => {
    const h = 3_600_000;
    expect(distinctLimits([[10 * h, 'session'], [11 * h, 'session'], [16 * h, 'session'], [12 * h, 'weekly'], [30 * h, 'weekly']]))
      .toEqual([{ kind: 'session', at: 10 * h }, { kind: 'weekly', at: 12 * h }, { kind: 'session', at: 16 * h }]);
  });
});

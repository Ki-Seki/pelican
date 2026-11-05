import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Usage for `pelican --demo`, kept plausible: the tokens each reply reports, the app each session
 * ran in, a few weeks of older sessions, Claude Code's own stats from before them, and how long
 * Claude waited for answers in the sessions Pelican ran. Times are relative to now, like the rest
 * of the demo.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The app each of the demo's sessions ran in (its Claude Code entrypoint); the others are Claude Desktop's. */
const APPS: Record<string, string> = {
  'a3f1c2d4-1111-4a1b-8c3d-000000000001': 'sdk-ts',
  'c9d3b8e2-3333-4c3d-ae5f-000000000003': 'sdk-ts',
  'd1e4c7f3-4444-4d4e-bf60-000000000004': 'claude-vscode',
};

/** Sessions Pelican ran: the Agent SDK's rows in them are Pelican's. */
const PELICAN = ['a3f1c2d4-1111-4a1b-8c3d-000000000001', 'c9d3b8e2-3333-4c3d-ae5f-000000000003', 'e6c1a7d2-9999-4e1c-8d2a-00000000000d'];

/**
 * What a reply in the demo reports, from where it sits in its session: the first writes the
 * system prompt and tools to the cache, later ones read a context that grows a little each time.
 */
function replyUsage(seed: number, index: number) {
  const wiggle = (n: number) => Math.round(n * (0.8 + (((seed * 7919 + index * 104729) % 97) / 97) * 0.4));
  return {
    input_tokens: wiggle(6),
    output_tokens: wiggle(220 + 140 * (index % 5)),
    cache_read_input_tokens: index === 0 ? wiggle(12_400) : wiggle(21_000 + 7_400 * index),
    cache_creation_input_tokens: index === 0 ? wiggle(18_600) : wiggle(1_300 + 600 * (index % 3)),
    service_tier: 'standard',
  };
}

const replies = new Map<string, number>();

/** The fields a demo row gets for usage, in the order the session's rows are written: its app, and for a reply its usage and request. */
export function demoRowUsage(sessionId: string, role: 'user' | 'assistant'): { entrypoint: string; usage?: ReturnType<typeof replyUsage>; requestId?: string } {
  const entrypoint = APPS[sessionId] ?? 'claude-desktop';
  if (role !== 'assistant') return { entrypoint };
  const index = replies.get(sessionId) ?? 0;
  replies.set(sessionId, index + 1);
  const seed = Number.parseInt(sessionId.slice(-4), 16);
  return { entrypoint, usage: replyUsage(seed, index), requestId: `req_demo_${sessionId.slice(-6)}_${index}` };
}

type Earlier = { id: string; title: string; project: string; daysAgo: number; hour: number; app: string; model: string; replies: number; prompt: string; reply: string; compacted?: number; limit?: string };

/** Older sessions, over the last three weeks: a usual mix of projects, apps and models. */
const EARLIER: Earlier[] = [
  {
    id: 'e1a2b3c4-aaaa-4a1a-8b1b-00000000000a', title: 'Add a CSV export to the reports page', project: 'acme-web', daysAgo: 2, hour: 10, app: 'claude-desktop', model: 'claude-opus-5-5', replies: 9,
    prompt: 'Add a CSV export to the reports page, with the same columns as the table.',
    reply: 'Export is in place: **Download CSV** above the table writes the visible columns, in the table\'s order, and respects the current filters.',
  },
  {
    id: 'e2b3c4d5-bbbb-4b2b-9c2c-00000000000b', title: 'Explain how the retry queue works', project: 'data-pipeline', daysAgo: 3, hour: 16, app: 'cli', model: 'claude-sonnet-5-5', replies: 4,
    prompt: 'How does the retry queue decide when to try an export again?',
    reply: 'A failed export goes back on the queue with a delay that doubles each time, from 1 to 32 minutes; after six tries it is marked failed and the owner gets an email.',
  },
  {
    id: 'e3c4d5e6-cccc-4c3c-ad3d-00000000000c', title: 'Upgrade the test runner', project: 'acme-web', daysAgo: 5, hour: 13, app: 'claude-vscode', model: 'claude-opus-5-5', replies: 16, compacted: 3,
    prompt: 'Upgrade the test runner to the new major version and fix whatever breaks.',
    reply: 'The upgrade is done and all 412 tests pass. Three things changed: the config file moved to `test.config.ts`, snapshot names lost their numeric suffix, and two tests needed `await` on `expect(...).resolves`.',
    limit: "You've hit your 5-hour limit · resets 6pm",
  },
  {
    id: 'e6c1a7d2-9999-4e1c-8d2a-00000000000d', title: 'Draft the Q4 roadmap page', project: 'docs-site', daysAgo: 8, hour: 11, app: 'sdk-ts', model: 'claude-opus-5-5', replies: 5,
    prompt: 'Draft a roadmap page for Q4 from the issues labelled q4.',
    reply: 'The draft is in `docs/roadmap.md`: three themes (speed, exports, accounts), each with its issues and a one-line why.',
  },
  {
    id: 'e5e6f7a8-eeee-4e5e-8f5f-00000000000e', title: 'Speed up the signup query', project: 'data-pipeline', daysAgo: 12, hour: 14, app: 'cli', model: 'claude-opus-5-5', replies: 8,
    prompt: 'The signups dashboard takes 9 seconds to load. Find out why and fix it.',
    reply: 'An index on `signups(created_at, plan)` brings the query from 8.7 s to 40 ms; the migration is in `migrations/0042_signup_index.sql`.',
    limit: "You've hit your 5-hour limit · resets 5pm",
  },
  {
    id: 'e7f8a9b0-ffff-4f7f-9a7a-00000000000f', title: 'Fix the date picker on Safari', project: 'acme-web', daysAgo: 19, hour: 9, app: 'claude-desktop', model: 'claude-sonnet-5-5', replies: 5,
    prompt: 'The date picker shows the wrong month on Safari. Fix it.',
    reply: 'Safari reads `2026-10-01` without a time as UTC, so west of Greenwich it became September 30. The picker now builds dates from their parts.',
  },
];

const compactSummary = (title: string) => `This session is being continued from a previous conversation that ran out of context. Summary: working on "${title}"; the work so far and the files touched are noted above.`;

/** Writes the older sessions, Claude Code's own stats from before them, and Pelican's record of its sessions. */
export async function writeDemoUsage(root: string, claudeHome: string): Promise<void> {
  const now = Date.now();
  let roadmapWait = now - 8 * DAY;
  for (const session of EARLIER) {
    const cwd = path.join(root, 'code', session.project);
    const dir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    const start = new Date(now - session.daysAgo * DAY);
    start.setHours(session.hour, 12, 0, 0);
    let t = start.getTime();
    let parent: string | null = null;
    const lines: string[] = [JSON.stringify({ type: 'custom-title', customTitle: session.title, sessionId: session.id })];
    let n = 0;
    const row = (type: string, extra: Record<string, unknown>) => {
      const uuid = `${session.id.slice(0, 24)}${String(n).padStart(12, '0')}`;
      n += 1;
      lines.push(JSON.stringify({
        parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: session.id, version: '2.1.318',
        gitBranch: 'main', type, uuid, timestamp: new Date(t).toISOString(), entrypoint: session.app, ...extra,
      }));
      parent = uuid;
    };
    row('user', { message: { role: 'user', content: session.prompt } });
    const seed = Number.parseInt(session.id.slice(-4), 16);
    const compactEvery = session.compacted ? Math.floor(session.replies / (session.compacted + 1)) : 0;
    for (let i = 0; i < session.replies; i += 1) {
      t += (3 + (i % 4)) * MIN;
      if (compactEvery && i > 0 && i % compactEvery === 0 && i / compactEvery <= session.compacted!) {
        const before = parent;
        lines.push(JSON.stringify({
          parentUuid: null, logicalParentUuid: before, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
          compactMetadata: { trigger: 'auto', preTokens: 168_000 }, uuid: `${session.id.slice(0, 24)}c${String(i).padStart(11, '0')}`, timestamp: new Date(t).toISOString(),
          cwd, sessionId: session.id, version: '2.1.318', entrypoint: session.app,
        }));
        parent = `${session.id.slice(0, 24)}c${String(i).padStart(11, '0')}`;
        row('user', { isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: compactSummary(session.title) } });
      }
      if (session.limit && i === Math.floor(session.replies * 0.6)) {
        // Claude Code's note that the 5-hour limit was reached, in place of a reply; the work goes on after the reset.
        row('assistant', {
          message: { id: `msg_limit_${session.id.slice(-6)}`, model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text: session.limit }] },
          isApiErrorMessage: true, error: 'rate_limit',
        });
        t += 2 * HOUR;
        row('user', { message: { role: 'user', content: 'Carry on.' } });
      }
      const last = i === session.replies - 1;
      if (session.id === PELICAN[2] && i === 2) {
        roadmapWait = t;
        t += 4 * MIN;
      }
      row('assistant', {
        requestId: `req_demo_${session.id.slice(-6)}_${i}`,
        message: {
          id: `msg_demo_${session.id.slice(-6)}_${i}`, type: 'message', role: 'assistant', model: session.model,
          content: [{ type: 'text', text: last ? session.reply : i === 0 ? 'I’ll start by reading the code involved.' : 'Next step.' }],
          usage: replyUsage(seed, i),
        },
      });
    }
    await writeFile(path.join(dir, `${session.id}.jsonl`), `${lines.join('\n')}\n`);
  }

  // Claude Code's own stats, as /stats left them three weeks ago: the days before the oldest transcript here.
  const through = Math.floor((now - 21 * DAY) / DAY);
  const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
  const dailyActivity: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }> = [];
  for (let back = 40; back >= 0; back -= 1) {
    // About four days a week.
    if ([1, 4, 6].includes((back * 5 + 3) % 7)) continue;
    const sessions = 1 + ((back * 3) % 3);
    dailyActivity.push({ date: iso(through - back), messageCount: 40 * sessions + (back % 9) * 6, sessionCount: sessions, toolCallCount: 14 * sessions });
  }
  await writeFile(path.join(claudeHome, 'stats-cache.json'), JSON.stringify({
    version: 5,
    lastComputedDate: iso(through),
    dailyActivity,
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: dailyActivity.reduce((sum, d) => sum + d.sessionCount, 0),
    totalMessages: dailyActivity.reduce((sum, d) => sum + d.messageCount, 0),
    longestSession: { sessionId: 'e0d1c2b3-0000-4000-8000-000000000010', duration: 3 * HOUR + 42 * MIN, messageCount: 310, timestamp: new Date((through - 12) * DAY + 9 * HOUR).toISOString() },
    firstSessionDate: new Date((through - 40) * DAY + 10 * HOUR).toISOString(),
    hourCounts: {},
  }, null, 2));

  // The sessions Pelican ran, and the time Claude waited there for an approval or an answer.
  const wait = (id: string, at: number, ms: number): [string, number, number] => [id, at, at + ms];
  await mkdir(path.join(root, 'state', 'usage'), { recursive: true });
  await writeFile(path.join(root, 'state', 'usage', 'pelican.json'), JSON.stringify({
    sessions: Object.fromEntries(PELICAN.map((id) => [id, now - 9 * DAY])),
    // The flaky-test plan waited a minute for its approval; the roadmap's draft four minutes for an answer.
    waits: [
      wait(PELICAN[1]!, now - 3 * HOUR + 30_000, 60_000),
      wait(PELICAN[2]!, roadmapWait, 4 * MIN),
    ],
  }));
}

// Claude sending a file in a session Pelican starts, as the Claude Code the Agent SDK bundles runs
// it, against a stand-in API (stand-in-api.ts), in this test's temporary folders.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ToolResultBlock } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { feedFor } from '../src/server/feed';
import { closeAll, getRun, sendMessage } from '../src/server/runner';
import { sentFiles } from '../src/server/sessions';
import { refreshTranscriptIndex, transcriptPath } from '../src/server/transcripts';
import { type ContentBlock, type MessagesRequest, type StandIn, standInApi, until } from './stand-in-api';

const home = vi.hoisted(() => {
  // Nothing of a Claude Code this test may itself run under reaches the one it starts (its
  // entrypoint, its session), and the computer's own home stays out of it: test/setup.ts made the folders.
  for (const key of Object.keys(process.env)) if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete process.env[key];
  process.env.HOME = `${process.env.CLAUDE_CONFIG_DIR}-home`;
  return process.env.HOME;
});

type Tool = { name: string; input_schema?: { properties?: Record<string, unknown> }; defer_loading?: boolean };

let api: StandIn;
let folder: string;
let session: string;
const live: ChatMessage[] = [];
/** What a page that asked for the file the moment its result came got. */
let shownAtOnce: Promise<Response> | Response | undefined;

/** The turns Claude was asked to take (not titles or suggestions, which come without tools). */
const turns = () => api.requests.filter((request) => (request.tools?.length ?? 0) > 0);
const results = (request: MessagesRequest): ContentBlock[] =>
  (request.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : []));

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  folder = path.join(realpathSync(path.dirname(config.claudeHome)), 'reports');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'report.md'), '# Signups\n\n12,480 last week, 18% more.\n');
  api = await standInApi((request) => {
    if (!turns().includes(request)) return 'OK.';
    return results(request).length === 0
      ? { tool: 'SendUserFile', input: { files: ['report.md'], caption: 'Here is the report.', status: 'normal' } }
      : 'Sent it.';
  });
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-stand-in',
    // Without the host's word, this alone would keep SendUserFile off.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
  });
  config.auth = 'auto';
  await loadAuth();
  session = await sendMessage({ cwd: folder }, { text: 'Send me the report', attachments: [], settings: {} });
  feedFor(session).listeners.add((event) => {
    if (event.type !== 'message') return;
    live.push(event.message);
    // A page asks for the file as soon as the card shows, before Claude Code's transcript has the row.
    const sent = event.message.blocks.find((block): block is ToolResultBlock => block.type === 'tool_result' && Boolean(block.delivered));
    const file = sent?.delivered?.files[0]?.path;
    if (file && !shownAtOnce) {
      shownAtOnce = app.request(`/api/sessions/${session}/sent?path=${encodeURIComponent(file)}`, {
        headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}` },
      });
    }
  });
  await until(() => turns().some((request) => results(request).length > 0) && getRun(session)?.busy === false, 90_000, 'the turn that sends the file');
}, 120_000);

afterAll(async () => {
  closeAll();
  await api?.close();
});

describe('a session Pelican starts, in the Claude Code the Agent SDK bundles', () => {
  it('has SendUserFile on: Claude gets it whole with every turn, not behind a search', () => {
    const tool = (turns()[0]!.tools as Tool[]).find((t) => t.name === 'SendUserFile');
    expect(tool).toBeDefined();
    expect(tool!.defer_loading).not.toBe(true);
    expect(Object.keys(tool!.input_schema?.properties ?? {})).toEqual(expect.arrayContaining(['files', 'caption', 'status', 'display']));
  });

  it('delivers the file, and Claude Code records where it is', async () => {
    const answered = results(turns().at(-1)!)[0]!;
    expect(answered.is_error).not.toBe(true);
    expect(answered.content).toBe('1 file delivered to user.');
    await refreshTranscriptIndex();
    const file = (await transcriptPath(session))!;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { toolUseResult?: { attachments?: Array<{ path: string }> } });
    const recorded = rows.find((row) => row.toolUseResult?.attachments);
    expect(recorded?.toolUseResult).toMatchObject({ caption: 'Here is the report.', attachments: [{ path: path.join(folder, 'report.md'), isImage: false, pathValidated: true }] });
  });

  it('shows the file in the conversation as the result comes, from where Claude Code checked it', async () => {
    const answered = results(turns().at(-1)!)[0]!;
    const result = live.flatMap((message) => message.blocks).find((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === answered.tool_use_id);
    expect(result?.delivered).toEqual({ files: [{ path: path.join(folder, 'report.md'), size: 39, type: 'text/markdown' }], caption: 'Here is the report.' });
    const response = await shownAtOnce!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: '# Signups\n\n12,480 last week, 18% more.\n' });
    // And from the transcript once Claude Code has written it, after its Claude has gone.
    await refreshTranscriptIndex();
    expect([...(await sentFiles(session))]).toEqual([path.join(folder, 'report.md')]);
  });
});

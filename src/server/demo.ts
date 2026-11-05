import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ModelOption, RunState } from '../shared/protocol.js';
import { config } from './config.js';
import { SETTINGS_SCREENSHOT } from './demo-image.js';
import { demoRowUsage, writeDemoUsage } from './demo-usage.js';
import { REPORT_HTML, SIGNUPS_CSV, signupsChart } from './demo-visuals.js';

/**
 * `pelican --demo`: a made-up home with a few sessions, for trying Pelican
 * without Claude Code and for screenshots that show no real work. It is
 * written fresh on every start, with times relative to now. Nothing runs.
 */

const run = promisify(execFile);
const MIN = 60_000;
const HOUR = 60 * MIN;

type Block = Record<string, unknown>;
type Row = { role: 'user' | 'assistant'; content: string | Block[]; at: number };

const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, isError = false): Block => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });
const text = (value: string): Block => ({ type: 'text', text: value });

function numbered(source: string): string {
  return source.split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
}

type DemoSession = { id: string; title: string; project: string; branch: string; rows: (cwd: string) => Row[]; scratch?: boolean };

const THEME_CSS = `:root {
  --bg: #ffffff;
  --fg: #111111;
  --muted: #6b6b6b;
  --accent: #2563eb;
}

body {
  background: var(--bg);
  color: var(--fg);
}`;

const SESSIONS: DemoSession[] = [
  {
    id: 'a3f1c2d4-1111-4a1b-8c3d-000000000001',
    title: 'Add a dark theme to the settings page',
    project: 'acme-web',
    branch: 'feat/dark-theme',
    rows: (cwd) => {
      const t = Date.now() - 4 * MIN;
      return [
        {
          role: 'user',
          at: t,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SETTINGS_SCREENSHOT } },
            text('Add a dark theme to the settings page, with a toggle. Keep the colors in CSS variables.'),
          ],
        },
        { role: 'assistant', at: t + 4000, content: [text("I'll look at how the colors are set up first."), tool('t1', 'Read', { file_path: `${cwd}/src/styles/theme.css` })] },
        { role: 'user', at: t + 5000, content: [result('t1', numbered(THEME_CSS))] },
        {
          role: 'assistant',
          at: t + 9000,
          content: [
            text('The colors are already variables, so a dark theme is one more set of values plus a toggle that switches them.'),
            tool('t2', 'TodoWrite', {
              todos: [
                { content: 'Add dark color values', status: 'completed', activeForm: 'Adding dark color values' },
                { content: 'Add the toggle to Settings', status: 'in_progress', activeForm: 'Adding the toggle to Settings' },
                { content: 'Remember the choice', status: 'pending', activeForm: 'Remembering the choice' },
                { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
              ],
            }),
          ],
        },
        { role: 'user', at: t + 9500, content: [result('t2', 'Todos have been modified successfully.')] },
        {
          role: 'assistant',
          at: t + 14000,
          content: [tool('t3', 'Edit', {
            file_path: `${cwd}/src/styles/theme.css`,
            old_string: '  --accent: #2563eb;\n}',
            new_string: "  --accent: #2563eb;\n}\n\n:root[data-theme='dark'] {\n  --bg: #0b0b0c;\n  --fg: #ededed;\n  --muted: #a1a1a1;\n  --accent: #60a5fa;\n}",
          })],
        },
        { role: 'user', at: t + 15000, content: [result('t3', `The file ${cwd}/src/styles/theme.css has been updated successfully.`)] },
        { role: 'assistant', at: t + 19000, content: [text('Now the toggle itself, next to the other display settings:')] },
      ];
    },
  },
  {
    id: 'b7e2a9c1-2222-4b2c-9d4e-000000000002',
    title: 'Why is the nightly export slow?',
    project: 'data-pipeline',
    branch: 'main',
    rows: (cwd) => {
      const t = Date.now() - 26 * MIN;
      return [
        { role: 'user', at: t, content: 'The nightly export went from 4 minutes to 40. Can you find out why?' },
        { role: 'assistant', at: t + 5000, content: [tool('g1', 'Grep', { pattern: 'def export_rows', path: `${cwd}/pipeline` })] },
        { role: 'user', at: t + 6000, content: [result('g1', 'pipeline/export.py:41:def export_rows(batch):')] },
        { role: 'assistant', at: t + 9000, content: [tool('g2', 'Read', { file_path: `${cwd}/pipeline/export.py`, offset: 35, limit: 30 })] },
        { role: 'user', at: t + 10000, content: [result('g2', numbered('def export_rows(batch):\n    for row in batch:\n        owner = db.fetch_owner(row.owner_id)\n        write(row, owner)'))] },
        { role: 'assistant', at: t + 15000, content: [tool('g3', 'Bash', { command: 'python -m cProfile -s cumtime -m pipeline.export --sample 5000 | head -8', description: 'Profile the export on a 5,000-row sample' })] },
        {
          role: 'user',
          at: t + 31000,
          content: [result('g3', '   ncalls  tottime  cumtime  filename:lineno(function)\n     5000    0.412   61.902  db.py:88(fetch_owner)\n        1    0.020   62.410  export.py:41(export_rows)\n     5000    0.301    0.488  writer.py:12(write)')],
        },
        {
          role: 'assistant',
          at: t + 40000,
          content: [text([
            'Found it: `export_rows` looks up each row\'s owner one query at a time. Since the owners table grew past a million rows that lookup is no longer cached, so 5,000 rows cost 5,000 round trips.',
            '',
            '| | Before | After batching |',
            '|---|---|---|',
            '| Queries per 5,000 rows | 5,000 | 1 |',
            '| Time on the sample | 62.4 s | 0.9 s |',
            '',
            'The fix fetches the owners for the whole batch at once:',
            '',
            '```python',
            'owners = db.fetch_owners({row.owner_id for row in batch})',
            'for row in batch:',
            '    write(row, owners[row.owner_id])',
            '```',
            '',
            'Want me to apply it and add a test that counts the queries?',
          ].join('\n'))],
        },
      ];
    },
  },
  {
    id: 'c9d3b8e2-3333-4c3d-ae5f-000000000003',
    title: 'Fix the flaky login test',
    project: 'acme-web',
    branch: 'fix/login-test',
    rows: (cwd) => {
      const t = Date.now() - 3 * HOUR;
      return [
        { role: 'user', at: t, content: 'The login test fails about one run in five on CI. Plan a fix first.' },
        {
          role: 'assistant',
          at: t + 30000,
          content: [tool('p1', 'ExitPlanMode', {
            plan: '## Fix the flaky login test\n\nThe test clicks **Sign in** before the form has loaded its CSRF token, so the request is sometimes rejected.\n\n1. Wait for the token field to be filled before submitting.\n2. Replace the fixed 500 ms sleep with that wait.\n3. Run the test 50 times in a row to confirm.',
          })],
        },
        { role: 'user', at: t + 90000, content: [result('p1', 'User has approved your plan. You can now start coding.')] },
        {
          role: 'assistant',
          at: t + 95000,
          content: [tool('p2', 'Edit', {
            file_path: `${cwd}/tests/login.spec.ts`,
            old_string: "  await page.waitForTimeout(500);\n  await page.click('text=Sign in');",
            new_string: "  await expect(page.locator('input[name=csrf]')).not.toHaveValue('');\n  await page.click('text=Sign in');",
          })],
        },
        { role: 'user', at: t + 96000, content: [result('p2', `The file ${cwd}/tests/login.spec.ts has been updated successfully.`)] },
        { role: 'assistant', at: t + 99000, content: [tool('p3', 'Bash', { command: 'npx playwright test tests/login.spec.ts --repeat-each=50', description: 'Run the login test 50 times' })] },
        { role: 'user', at: t + 160000, content: [result('p3', 'Running 50 tests using 4 workers\n\n  50 passed (58.2s)')] },
        { role: 'assistant', at: t + 165000, content: [text('All 50 runs pass now. The test waits for the CSRF token instead of sleeping, so it is also about 400 ms faster.')] },
      ];
    },
  },
  {
    id: 'd1e4c7f3-4444-4d4e-bf60-000000000004',
    title: 'Release notes for v2.4',
    project: 'docs-site',
    branch: 'main',
    rows: () => {
      const t = Date.now() - 26 * HOUR;
      return [
        { role: 'user', at: t, content: 'Write the release notes for v2.4 from the merged pull requests.' },
        {
          role: 'assistant',
          at: t + 50000,
          content: [text('## v2.4\n\n**Highlights**\n\n- A dark theme, which follows your system setting or can be chosen in Settings.\n- Exports are about 60 times faster on large accounts.\n\n**Fixes**\n\n- The login page no longer fails when submitted right after it opens.\n- Long project names no longer push the menu off screen on phones.')],
        },
      ];
    },
  },
  {
    id: 'f3a6e9b5-6666-4f60-9182-000000000006',
    title: "Chart last week's signups",
    project: 'data-pipeline',
    branch: 'main',
    rows: (cwd) => {
      const t = Date.now() - 50 * MIN;
      return [
        { role: 'user', at: t, content: "Chart last week's signups by day, and make me a one-page summary I can share." },
        { role: 'assistant', at: t + 3000, content: [text("I'll read the numbers first."), tool('v1', 'Read', { file_path: `${cwd}/data/signups.csv` })] },
        { role: 'user', at: t + 4000, content: [result('v1', numbered(SIGNUPS_CSV.trimEnd()))] },
        { role: 'assistant', at: t + 9000, content: [tool('v2', 'mcp__visualize__show_widget', { title: 'signups_by_day', loading_messages: ['Stacking the bars'], widget_code: signupsChart() })] },
        { role: 'user', at: t + 10000, content: [result('v2', 'Shown to the user.')] },
        { role: 'assistant', at: t + 16000, content: [tool('v3', 'Write', { file_path: `${cwd}/reports/signups-week-45.html`, content: REPORT_HTML })] },
        { role: 'user', at: t + 17000, content: [result('v3', `File created successfully at: ${cwd}/reports/signups-week-45.html`)] },
        {
          role: 'assistant',
          at: t + 21000,
          content: [text('Signups grew **18%** to 12,480. Thursday was the best day (2,214), the day the newsletter went out, and the weekend stayed above the weekday average.\n\nThe one-pager is in `reports/signups-week-45.html`: the three numbers that matter and the chart. Open it from the step above.')],
        },
      ];
    },
  },
  // A scheduled check: every run is a session of its own, with the same folder and prompt.
  // The list folds them into the newest.
  ...[1, 7, 13].map((hours, i): DemoSession => ({
    id: `a8b9c0d1-7777-4a7b-8c7d-00000000000${7 + i}`,
    title: 'Check the export queue',
    project: 'data-pipeline',
    branch: 'main',
    rows: () => {
      const t = Date.now() - hours * HOUR;
      const id = `q${i}`;
      return [
        { role: 'user', at: t, content: 'Check the export queue: is anything stuck or failing?' },
        { role: 'assistant', at: t + 4000, content: [tool(id, 'Bash', { command: 'python3 pipeline/queue.py --status', description: 'Show the queue' })] },
        { role: 'user', at: t + 6000, content: [result(id, ['queued 0  running 1  failed 0', 'queued 3  running 1  failed 0', 'queued 0  running 0  failed 0'][i]!)] },
        { role: 'assistant', at: t + 8000, content: [text(['All clear: one export running, nothing stuck.', 'Three exports waiting behind one that runs; none failed.', 'All clear: the queue is empty.'][i]!)] },
      ];
    },
  })),
  {
    id: 'e2f5d8a4-5555-4e5f-8071-000000000005',
    title: 'Turn this CSV into JSON',
    project: 'scratch',
    branch: '',
    scratch: true,
    rows: (cwd) => {
      const t = Date.now() - 29 * HOUR;
      return [
        { role: 'user', at: t, content: 'Turn contacts.csv into a JSON array, one object per row.' },
        { role: 'assistant', at: t + 6000, content: [tool('s1', 'Bash', { command: "python3 -c \"import csv, json; print(json.dumps(list(csv.DictReader(open('contacts.csv'))), indent=2))\" > contacts.json && wc -l contacts.json", description: 'Convert the CSV to JSON' })] },
        { role: 'user', at: t + 8000, content: [result('s1', `   1203 ${cwd}/contacts.json`)] },
        { role: 'assistant', at: t + 10000, content: [text('Done: `contacts.json` has 200 objects, with the CSV header as keys.')] },
      ];
    },
  },
];

const SETTINGS_TSX = `import { FontSizePicker } from './FontSizePicker';
import { Section } from './Section';

export function Settings() {
  return (
    <Section title="Display">
      <FontSizePicker />
    </Section>
  );
}
`;

const TOGGLE_TSX = `type Theme = 'light' | 'dark';

/** Switches the page between the light and dark color values in theme.css. */
export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return (
    <label className="row">
      Dark theme
      <input type="checkbox" checked={value === 'dark'} onChange={(e) => onChange(e.target.checked ? 'dark' : 'light')} />
    </label>
  );
}
`;

const DARK_CSS = `${THEME_CSS.replace('  --accent: #2563eb;\n}', "  --accent: #2563eb;\n}\n\n:root[data-theme='dark'] {\n  --bg: #0b0b0c;\n  --fg: #ededed;\n  --muted: #a1a1a1;\n  --accent: #60a5fa;\n}")}\n`;

const FILE_TEXT: Record<string, string> = {
  'acme-web/src/styles/theme.css': `${THEME_CSS}\n`,
  'acme-web/src/settings/Settings.tsx': SETTINGS_TSX,
  'acme-web/README.md': '# acme-web\n\nThe Acme web app.\n',
  'data-pipeline/README.md': '# data-pipeline\n\nNightly exports and the numbers behind them.\n',
  'data-pipeline/data/signups.csv': SIGNUPS_CSV,
  'data-pipeline/reports/signups-week-45.html': REPORT_HTML,
  'docs-site/README.md': '# docs-site\n\nThe public docs.\n',
};

/**
 * The first project is a git repository with Claude's work so far left
 * uncommitted, so the Changes panel has something to show. Skipped without git.
 */
async function demoRepository(dir: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
  // Your own git setup (hooks, templates, signing) has no say in the demo's repository.
  const git = (args: string[]) => run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', ...args], { cwd: dir, env, timeout: 10_000 });
  try {
    await git(['init', '-q', '-b', 'feat/dark-theme']);
    await rm(path.join(dir, 'src/settings/ThemeToggle.tsx'), { force: true });
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'Settings page']);
    await writeFile(path.join(dir, 'src/styles/theme.css'), DARK_CSS);
    await writeFile(path.join(dir, 'src/settings/ThemeToggle.tsx'), TOGGLE_TSX);
  } catch {
    // No git here; the panel shows the files only.
  }
}

const DEMO_FILES: Record<string, string[]> = {
  'acme-web': ['README.md', 'package.json', 'src/app.tsx', 'src/settings/Settings.tsx', 'src/settings/ThemeToggle.tsx', 'src/styles/theme.css', 'tests/login.spec.ts'],
  'data-pipeline': ['README.md', 'data/signups.csv', 'pipeline/export.py', 'pipeline/db.py', 'pipeline/writer.py', 'reports/signups-week-45.html', 'tests/test_export.py'],
  'docs-site': ['README.md', 'docs/releases.md'],
};

/** Writes the demo home and points the config (and the Claude Agent SDK) at it. */
export async function prepareDemo(): Promise<void> {
  const root = path.join(config.stateDir, 'demo');
  await rm(root, { recursive: true, force: true });
  const claudeHome = path.join(root, '.claude');
  for (const [project, files] of Object.entries(DEMO_FILES)) {
    for (const file of files) {
      const full = path.join(root, 'code', project, file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, FILE_TEXT[`${project}/${file}`] ?? '');
    }
  }
  await demoRepository(path.join(root, 'code', 'acme-web'));
  for (const session of SESSIONS) {
    const cwd = session.scratch ? path.join(root, 'scratch', '2026-11-04-7c2e') : path.join(root, 'code', session.project);
    await mkdir(cwd, { recursive: true });
    const dir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    let parent: string | null = null;
    const lines: string[] = [JSON.stringify({ type: 'custom-title', customTitle: session.title, sessionId: session.id })];
    for (const row of session.rows(cwd)) {
      const uuid = randomUUID();
      const { usage, ...meta } = demoRowUsage(session.id, row.role);
      const message = row.role === 'assistant'
        ? { id: `msg_demo_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: row.content, ...(usage ? { usage } : {}) }
        : { role: 'user', content: row.content };
      lines.push(JSON.stringify({
        parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: session.id, version: '2.1.318',
        gitBranch: session.branch, type: row.role, message, uuid, timestamp: new Date(row.at).toISOString(), ...meta,
      }));
      parent = uuid;
    }
    await writeFile(path.join(dir, `${session.id}.jsonl`), `${lines.join('\n')}\n`);
  }
  await writeDemoUsage(root, claudeHome);
  config.home = root;
  config.claudeHome = claudeHome;
  // Its own config and state too: the demo never reads or writes your password, token or push keys.
  config.configDir = path.join(root, 'config');
  config.stateDir = path.join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.PELICAN_SCRATCH_DIR = path.join(root, 'scratch');
}

export const DEMO_MODELS: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus · best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'opus', label: 'Opus', description: 'For complex work', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet', description: 'Efficient for everyday tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: false, resolvedModel: 'claude-sonnet-5-5' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest for quick answers', efforts: [], supportsFast: false, resolvedModel: 'claude-haiku-5-5' },
];

/** The first demo session waits for an approval; another one is busy in Claude Desktop. */
export function demoRunState(sessionId: string): RunState | undefined {
  const first = SESSIONS[0]!;
  if (sessionId !== first.id) return undefined;
  const cwd = path.join(config.home, 'code', first.project);
  return {
    sessionId,
    cwd,
    busy: true,
    settings: { model: 'default', effort: 'high', permissionMode: 'default' },
    partial: [],
    permissions: [{
      // The web app's demo (src/web/lib/demo.ts) plays out Allow on this id with a reply of its own.
      id: 'demo-permission',
      sessionId,
      toolName: 'Edit',
      input: {
        file_path: `${cwd}/src/settings/Settings.tsx`,
        old_string: '      <FontSizePicker />\n    </Section>',
        new_string: '      <FontSizePicker />\n      <ThemeToggle value={theme} onChange={setTheme} />\n    </Section>',
      },
      always: 'Allow all edits this session',
      createdAt: Date.now() - 20_000,
    }],
    context: { percent: 31, tokens: 62_000, max: 200_000 },
  };
}

export const DEMO_LIVE_SESSION = SESSIONS[1]!.id;
export const DEMO_WAITING_SESSION = SESSIONS[0]!.id;

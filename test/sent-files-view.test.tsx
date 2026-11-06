// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, Delivery, FileContent, RunState } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { api } = await import('../src/web/lib/api');
const { MessageList } = await import('../src/web/components/MessageList');

const SESSION = 'dddddddd-0000-4000-8000-000000000001';
const WORK = '/Users/ada/work';
const at = Date.now() - 10 * 60_000;

const call = (id: string, input: Record<string, unknown>, uuid = `a-${id}`): ChatMessage => ({
  uuid, role: 'assistant', timestamp: at, blocks: [{ type: 'tool_use', id, name: 'SendUserFile', input: { status: 'normal', ...input } }],
});
const answered = (id: string, delivered?: Delivery, error?: string): ChatMessage => ({
  uuid: `r-${id}`, role: 'user', timestamp: at + 1000,
  blocks: [{ type: 'tool_result', tool_use_id: id, content: error ?? `${delivered?.files.length ?? 0} files delivered to user.`, ...(error ? { is_error: true } : {}), ...(delivered ? { delivered } : {}) }],
});
const sent = (id: string, files: string[], extra: Partial<Delivery> = {}) => [
  call(id, { files: files.map((f) => f.split('/').pop()), ...(extra.caption ? { caption: extra.caption } : {}), ...(extra.display ? { display: extra.display } : {}) }),
  answered(id, { files: files.map((path) => ({ path, size: 2048, ...(/\.png$/.test(path) ? { image: true } : {}) })), ...extra }),
];
const prompt: ChatMessage = { uuid: 'u1', role: 'user', timestamp: at - 1000, blocks: [{ type: 'text', text: 'Send me the report' }] };

const running = (): RunState => ({ sessionId: SESSION, cwd: WORK, busy: true, settings: {}, permissions: [], partial: [] });

function show(messages: ChatMessage[], run?: RunState, mode: 'normal' | 'verbose' = 'normal') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (list: ChatMessage[], state?: RunState) => {
    const view: SessionView = { messages: list, offset: 0, total: list.length, loaded: true, loadingOlder: false, ...(state ? { run: state } : {}) };
    return <QueryClientProvider client={client}><MessageList sessionId={SESSION} view={view} cwd={WORK} mode={mode} /></QueryClientProvider>;
  };
  const shown = render(tree(messages, run));
  return { ...shown, again: (list: ChatMessage[], state?: RunState) => shown.rerender(tree(list, state)) };
}

const raw = (file: string, download = false) => api.sentUrl(SESSION, file, download);
const texts: Record<string, FileContent> = {
  [`${WORK}/report.md`]: { path: 'report.md', size: 40, text: '# Week 45\n\nSignups grew **18%**.\n' },
  [`${WORK}/signups.csv`]: { path: 'signups.csv', size: 30, text: 'day,signups\nThu,2214\n' },
  [`${WORK}/page.html`]: { path: 'page.html', size: 60, text: '<!doctype html><h1>Week 45</h1><script>run()</script>' },
  [`${WORK}/chart.svg`]: { path: 'chart.svg', size: 60, text: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>' },
};
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.spyOn(api, 'sent').mockImplementation(async (_id, file) => {
    asked.push(file);
    const content = texts[file];
    if (!content) throw new Error('Not a file Claude sent in this session');
    return content;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a file Claude sent', () => {
  it('shows as a picture, from where Claude Code delivered it, with its caption, opened large on a tap, and saved from its button', () => {
    show([prompt, ...sent('s1', [`${WORK}/shots/dark.png`], { caption: 'The settings page in the dark theme' })]);
    const group = screen.getByRole('group', { name: 'Sent file' });
    expect(within(group).getByText('The settings page in the dark theme')).toBeTruthy();
    const picture = within(group).getByRole('img', { name: 'dark.png' }) as HTMLImageElement;
    expect(picture.getAttribute('src')).toBe(raw(`${WORK}/shots/dark.png`));
    const save = within(group).getByRole('link', { name: 'Download dark.png' });
    expect(save.getAttribute('href')).toBe(raw(`${WORK}/shots/dark.png`, true));
    expect(save.getAttribute('download')).toBe('dark.png');
    fireEvent.click(within(group).getByRole('button', { name: 'Open dark.png' }));
    expect(asked).toEqual([]);
  });

  it('shows a page and an SVG as still previews, with Run where there is a script, and text to read', async () => {
    show([prompt, ...sent('s2', [`${WORK}/page.html`, `${WORK}/chart.svg`]), ...sent('s3', [`${WORK}/report.md`, `${WORK}/signups.csv`])]);
    await waitFor(() => expect(screen.getAllByTitle('page.html')).toHaveLength(1));
    expect(screen.getByTitle('chart.svg')).toBeTruthy();
    // The page's scripts wait for Run; the drawing has none to run.
    expect(screen.getAllByRole('button', { name: /Run/ })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Download page.html' }).getAttribute('href')).toBe(raw(`${WORK}/page.html`, true));
    // Markdown as it reads, anything else as it is.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Week 45' })).toBeTruthy());
    expect(screen.getByText('18%').tagName).toBe('STRONG');
    expect(screen.getByText(/Thu,2214/).tagName).toBe('PRE');
    expect(asked.sort()).toEqual([`${WORK}/chart.svg`, `${WORK}/page.html`, `${WORK}/report.md`, `${WORK}/signups.csv`]);
  });

  it('opens a PDF in a tab of its own, in the browser’s viewer, and offers anything else to save', () => {
    show([prompt, ...sent('s4', [`${WORK}/week-45.pdf`, `${WORK}/build.zip`])]);
    const pdf = screen.getByRole('link', { name: 'Open week-45.pdf' });
    expect(pdf.getAttribute('href')).toBe(raw(`${WORK}/week-45.pdf`));
    expect(pdf.getAttribute('target')).toBe('_blank');
    expect(pdf.textContent).toContain('2 KB');
    expect(screen.getByRole('link', { name: 'Download week-45.pdf' }).getAttribute('href')).toBe(raw(`${WORK}/week-45.pdf`, true));
    const zip = screen.getByRole('link', { name: 'Download build.zip' });
    expect(zip.getAttribute('href')).toBe(raw(`${WORK}/build.zip`, true));
    expect(zip.getAttribute('download')).toBe('build.zip');
    expect(asked).toEqual([]);
  });

  it('stays a card Claude meant to attach, read nowhere until it is opened', async () => {
    show([prompt, ...sent('s5', [`${WORK}/shots/dark.png`, `${WORK}/report.md`, `${WORK}/page.html`], { display: 'attach' })]);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTitle('page.html')).toBeNull();
    expect(asked).toEqual([]);
    const card = screen.getByRole('button', { name: 'report.md' });
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Week 45' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'dark.png' }));
    expect((screen.getByRole('img', { name: 'dark.png' }) as HTMLImageElement).getAttribute('src')).toBe(raw(`${WORK}/shots/dark.png`));
  });

  it('says how many files Claude Code could not send, and shows none of them', () => {
    show([prompt, ...sent('s6', [`${WORK}/build.zip`], { missed: 1 })]);
    expect(screen.getByText('1 more file could not be sent')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('says why a file it could not read is not there', async () => {
    show([prompt, ...sent('s7', [`${WORK}/gone.md`])]);
    await waitFor(() => expect(screen.getByText('Not a file Claude sent in this session')).toBeTruthy());
  });

  it('is never folded away among a long run of steps', () => {
    const reads: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      uuid: `read-${i}`, role: 'assistant', timestamp: at, blocks: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `${WORK}/f${i}.ts` } }],
    }));
    show([prompt, ...reads, ...sent('s8', [`${WORK}/build.zip`]), ...reads.map((r, i) => ({ ...r, uuid: `more-${i}`, blocks: [{ ...r.blocks[0]!, id: `more-${i}` }] as ChatMessage['blocks'] }))]);
    expect(screen.getAllByText(/steps/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Download build.zip' })).toBeTruthy();
  });
});

describe('a file Claude is sending', () => {
  it('says so while the call runs, then shows the file as the result comes', () => {
    const asking = call('s9', { files: ['report.md'] });
    const { again } = show([prompt, asking], running());
    expect(screen.getByText('Sending file')).toBeTruthy();
    expect(screen.getByText('report.md')).toBeTruthy();
    again([prompt, asking, answered('s9', { files: [{ path: `${WORK}/build.zip`, size: 2048 }] })], running());
    expect(screen.queryByText('Sending file')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download build.zip' })).toBeTruthy();
  });

  it('says it failed in Claude Desktop’s words, with Claude Code’s reason a tap away', () => {
    show([prompt, call('s10', { files: ['missing.md'] }), answered('s10', undefined, '<tool_use_error>Attachment "missing.md" does not exist.</tool_use_error>')]);
    expect(screen.getByText('Failed to send')).toBeTruthy();
    expect(screen.queryByText('failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Failed to send/ }));
    expect(screen.getByText('Attachment "missing.md" does not exist.')).toBeTruthy();
  });

  it('counts a call Claude Code delivered nothing for as failed, and a refused one as refused', () => {
    show([
      prompt,
      call('s11', { files: ['swapped.md'] }), answered('s11', { files: [], missed: 1 }),
      call('s12', { files: ['secret.txt'] }), { ...answered('s12', undefined, 'The user doesn\'t want to proceed with this tool use.'), blocks: [{ type: 'tool_result', tool_use_id: 's12', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true, denied: true }] },
    ]);
    expect(screen.getByText('Failed to send')).toBeTruthy();
    expect(screen.getByText('Send file')).toBeTruthy();
    expect(screen.getByText('denied')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, Delivery, FileContent, RunState } from '../src/shared/protocol';
import type { SentState } from '../src/web/lib/api';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { api, ApiError } = await import('../src/web/lib/api');
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
/** What a card's HEAD finds of each file; anything not named is there. */
let states: Record<string, SentState | Promise<SentState>> = {};

beforeEach(() => {
  asked = [];
  states = {};
  vi.spyOn(api, 'sent').mockImplementation(async (_id, file) => {
    asked.push(file);
    if (states[file] === 'gone') throw new ApiError('No longer on this computer', 410);
    const content = texts[file];
    if (!content) throw new Error('Not a file Claude sent in this session');
    return content;
  });
  vi.spyOn(api, 'sentStates').mockImplementation(async (_id, paths) => new Map(await Promise.all(paths.map(async (path) => [path, await (states[path] ?? 'there')] as const))));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a file Claude sent', () => {
  it('shows as a picture, from where Claude Code delivered it, with its caption, opened large on a tap, and saved from its button', async () => {
    show([prompt, ...sent('s1', [`${WORK}/shots/dark.png`], { caption: 'The settings page in the dark theme' })]);
    const group = screen.getByRole('group', { name: 'Sent file' });
    expect(within(group).getByText('The settings page in the dark theme')).toBeTruthy();
    const picture = await within(group).findByRole('img', { name: 'dark.png' }) as HTMLImageElement;
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

  it('opens a PDF in a tab of its own, in the browser’s viewer, and offers anything else to save', async () => {
    show([prompt, ...sent('s4', [`${WORK}/week-45.pdf`, `${WORK}/build.zip`])]);
    const pdf = await screen.findByRole('link', { name: 'Open week-45.pdf' });
    expect(pdf.getAttribute('href')).toBe(raw(`${WORK}/week-45.pdf`));
    expect(pdf.getAttribute('target')).toBe('_blank');
    expect(pdf.textContent).toContain('2 KB');
    expect(screen.getByRole('link', { name: 'Download week-45.pdf' }).getAttribute('href')).toBe(raw(`${WORK}/week-45.pdf`, true));
    const zip = screen.getByRole('link', { name: 'Download build.zip' });
    expect(zip.getAttribute('href')).toBe(raw(`${WORK}/build.zip`, true));
    expect(zip.getAttribute('download')).toBe('build.zip');
    expect(asked).toEqual([]);
  });

  it('shows its caption as Claude’s words, as a reply reads: Markdown and all', async () => {
    show([prompt, ...sent('s20', [`${WORK}/build.zip`], { caption: 'Here’s the **chart** and `report.md`, details on [the dashboard](https://example.com/d/1).' })]);
    const group = screen.getByRole('group', { name: 'Sent file' });
    expect(within(group).getByText('chart').tagName).toBe('STRONG');
    expect(within(group).getByText('report.md').tagName).toBe('CODE');
    const link = within(group).getByRole('link', { name: 'the dashboard' });
    expect(link.getAttribute('href')).toBe('https://example.com/d/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(group.textContent).not.toContain('**');
    // In a reply's type, not a label's.
    const words = within(group).getByText('chart').closest('.prose-chat')!;
    expect(words.className).not.toMatch(/text-muted|text-\[13\.5px\]/);
    await within(group).findByRole('link', { name: 'Download build.zip' });
  });

  it('lays pictures that come alone side by side, each at its own size up to 360 tall and 480 wide, as in Claude Desktop', async () => {
    const shots = [1, 2, 3, 4].map((n) => `${WORK}/shots/phone-${n}.png`);
    show([prompt, ...sent('s17', shots)]);
    const group = screen.getByRole('group', { name: 'Sent 4 files' });
    await within(group).findByRole('img', { name: 'phone-1.png' });
    for (const picture of within(group).getAllByRole('img')) {
      expect(picture.getAttribute('class')).toMatch(/\bmax-h-\[360px\] max-w-full\b/);
      const frame = picture.closest('.group')!;
      expect(frame.className).toContain('max-w-[min(100%,480px)]');
      // Nothing gives a picture a line of its own.
      expect(frame.parentElement).toBe(group);
      expect(frame.className).not.toContain('basis-full');
    }
    expect(within(group).getAllByRole('link', { name: /^Download phone-/ })).toHaveLength(4);
  });

  it('shows pictures beside other files as small squares, and the other files as tiles of their size', async () => {
    show([prompt, ...sent('s18', [`${WORK}/shots/dark.png`, `${WORK}/week-45.pdf`, `${WORK}/build.zip`])]);
    const group = screen.getByRole('group', { name: 'Sent 3 files' });
    const picture = await within(group).findByRole('img', { name: 'dark.png' });
    const square = (element: Element) => element.closest('.size-\\[120px\\]');
    expect(picture.getAttribute('class')).toContain('object-contain');
    expect(square(picture)).toBeTruthy();
    const pdf = within(group).getByRole('link', { name: 'Open week-45.pdf' });
    expect(square(pdf)).toBeTruthy();
    expect(pdf.textContent).toContain('2 KB');
    expect(square(within(group).getByRole('link', { name: 'Download week-45.pdf' }))).toBe(square(pdf));
    expect(square(within(group).getByRole('link', { name: 'Download build.zip' }))).toBeTruthy();
  });

  it('shows other files alone as cards of a line', async () => {
    show([prompt, ...sent('s19', [`${WORK}/week-45.pdf`, `${WORK}/build.zip`])]);
    const pdf = await screen.findByRole('link', { name: 'Open week-45.pdf' });
    expect(pdf.closest('.size-\\[120px\\]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download build.zip' }).closest('.size-\\[120px\\]')).toBeNull();
  });

  it('stays a card Claude meant to attach, read nowhere until it is opened', async () => {
    show([prompt, ...sent('s5', [`${WORK}/shots/dark.png`, `${WORK}/report.md`, `${WORK}/page.html`], { display: 'attach' })]);
    const card = await screen.findByRole('button', { name: 'report.md' });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTitle('page.html')).toBeNull();
    expect(asked).toEqual([]);
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Week 45' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'dark.png' }));
    expect((screen.getByRole('img', { name: 'dark.png' }) as HTMLImageElement).getAttribute('src')).toBe(raw(`${WORK}/shots/dark.png`));
  });

  it('says how many files Claude Code could not send, and shows none of them', async () => {
    show([prompt, ...sent('s6', [`${WORK}/build.zip`], { missed: 1 })]);
    expect(screen.getByText('1 more file could not be sent')).toBeTruthy();
    expect(await screen.findAllByRole('link')).toHaveLength(1);
  });

  it('says why a file it could not read is not there', async () => {
    show([prompt, ...sent('s7', [`${WORK}/gone.md`])]);
    await waitFor(() => expect(screen.getByText('Not a file Claude sent in this session')).toBeTruthy());
  });

  it('says one that is no longer on the computer is gone, the same for every type, with nothing to tap', async () => {
    const files = ['shots/dark.png', 'week-45.pdf', 'build.zip', 'report.md', 'page.html'].map((f) => `${WORK}/${f}`);
    for (const file of files) states[file] = 'gone';
    show([prompt, ...sent('s13', files)]);
    const group = screen.getByRole('group', { name: 'Sent 5 files' });
    await waitFor(() => expect(within(group).getAllByText('No longer on this computer')).toHaveLength(5));
    for (const name of ['dark.png', 'week-45.pdf', 'build.zip', 'report.md', 'page.html']) expect(within(group).getByText(name)).toBeTruthy();
    expect(within(group).getAllByText('2 KB')).toHaveLength(5);
    expect(within(group).queryAllByRole('link')).toEqual([]);
    expect(within(group).queryAllByRole('button')).toEqual([]);
    expect(within(group).queryByRole('img')).toBeNull();
    expect(within(group).queryByText(/can’t be shown/)).toBeNull();
  });

  it('says one too large to serve is so, before any tap', async () => {
    states[`${WORK}/build.zip`] = 'large';
    show([prompt, ...sent('s14', [`${WORK}/build.zip`])]);
    await waitFor(() => expect(screen.getByText('Larger than Pelican serves (200 MB)')).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'Download build.zip' })).toBeNull();
  });

  it('shows a call’s files once it knows which are still there, asking once for them all, and loads none before', async () => {
    let found: (state: SentState) => void = () => {};
    states[`${WORK}/shots/dark.png`] = new Promise<SentState>((resolve) => { found = resolve; });
    show([prompt, ...sent('s15', [`${WORK}/shots/dark.png`, `${WORK}/report.md`], { caption: 'Both' })]);
    const group = screen.getByRole('group', { name: 'Sent 2 files' });
    expect(within(group).getByText('Both')).toBeTruthy();
    expect(within(group).queryByRole('img')).toBeNull();
    expect(within(group).queryAllByRole('link')).toEqual([]);
    expect(asked).toEqual([]);
    found('there');
    await waitFor(() => expect(within(group).getByRole('img', { name: 'dark.png' })).toBeTruthy());
    expect(vi.mocked(api.sentStates).mock.calls).toEqual([[SESSION, [`${WORK}/shots/dark.png`, `${WORK}/report.md`]]]);
    // There, and still not a picture a browser can show.
    fireEvent.error(within(group).getByRole('img', { name: 'dark.png' }));
    expect(within(group).getByText('This picture can’t be shown here')).toBeTruthy();
    expect(within(group).getByRole('link', { name: 'Download dark.png' })).toBeTruthy();
  });

  it('shows the files as they would be should nobody be able to say which are there', async () => {
    vi.mocked(api.sentStates).mockRejectedValue(new ApiError('Can’t reach laptop', 0));
    show([prompt, ...sent('s16', [`${WORK}/build.zip`])]);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download build.zip' })).toBeTruthy());
  });

  it('is never folded away among a long run of steps', async () => {
    const reads: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      uuid: `read-${i}`, role: 'assistant', timestamp: at, blocks: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `${WORK}/f${i}.ts` } }],
    }));
    show([prompt, ...reads, ...sent('s8', [`${WORK}/build.zip`]), ...reads.map((r, i) => ({ ...r, uuid: `more-${i}`, blocks: [{ ...r.blocks[0]!, id: `more-${i}` }] as ChatMessage['blocks'] }))]);
    expect(screen.getAllByText(/steps/).length).toBeGreaterThan(0);
    expect(await screen.findByRole('link', { name: 'Download build.zip' })).toBeTruthy();
  });
});

describe('a file Claude is sending', () => {
  it('says so while the call runs, then shows the file as the result comes', async () => {
    const asking = call('s9', { files: ['report.md'] });
    const { again } = show([prompt, asking], running());
    expect(screen.getByText('Sending file')).toBeTruthy();
    expect(screen.getByText('report.md')).toBeTruthy();
    again([prompt, asking, answered('s9', { files: [{ path: `${WORK}/build.zip`, size: 2048 }] })], running());
    expect(screen.queryByText('Sending file')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Download build.zip' })).toBeTruthy();
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

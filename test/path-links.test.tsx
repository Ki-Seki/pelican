// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const asked = vi.hoisted(() => ({ batches: [] as string[][], there: new Set<string>() }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      exists: async (_cwd: string, paths: string[]) => {
        asked.batches.push(paths);
        return paths.filter((p) => asked.there.has(p));
      },
    },
  };
});

const { forgetFound, inFolder, parseRef, PathLinksContext } = await import('../src/web/lib/path-links');
const { Markdown } = await import('../src/web/components/Markdown');
const { ToolCallView } = await import('../src/web/components/ToolCall');

afterEach(() => {
  cleanup();
  forgetFound();
  asked.batches = [];
  asked.there = new Set();
});

describe('a file named in the conversation', () => {
  it('is read with its line or range, in code more freely than in prose', () => {
    expect(parseRef('src/server/app.ts:561')).toEqual({ path: 'src/server/app.ts', line: 561 });
    expect(parseRef('app.ts:7-8')).toEqual({ path: 'app.ts', line: 7, end: 8 });
    expect(parseRef('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(parseRef('src/a.ts#L3-L9')).toEqual({ path: 'src/a.ts', line: 3, end: 9 });
    expect(parseRef('README.md')).toEqual({ path: 'README.md' });
    expect(parseRef('Makefile')).toBeUndefined();
    expect(parseRef('npm test')).toBeUndefined();
    expect(parseRef('https://example.com/a.js')).toBeUndefined();
    expect(parseRef('process.env.PATH')).toEqual({ path: 'process.env.PATH' });
    // In prose a word needs more to be taken for a file.
    expect(parseRef('process.env', false)).toBeUndefined();
    expect(parseRef('e.g', false)).toBeUndefined();
    expect(parseRef('v2.4', false)).toBeUndefined();
    expect(parseRef('README.md', false)).toEqual({ path: 'README.md' });
    expect(parseRef('src/theme.css', false)).toEqual({ path: 'src/theme.css' });
  });

  it('opens only inside the session’s folder', () => {
    expect(inFolder('/code/app/src/a.ts', '/code/app')).toBe('src/a.ts');
    expect(inFolder('./src/a.ts', '/code/app')).toBe('src/a.ts');
    expect(inFolder('/code/apple/a.ts', '/code/app')).toBeUndefined();
    expect(inFolder('../secret.txt', '/code/app')).toBeUndefined();
    expect(inFolder('~/notes.md', '/code/app')).toBeUndefined();
  });

  it('in a reply, becomes a link to its line once the folder is known to hold it, asked in one batch', async () => {
    asked.there = new Set(['src/theme.css', 'README.md']);
    const openFile = vi.fn();
    render(
      <PathLinksContext.Provider value={{ cwd: '/code/app', openFile }}>
        <Markdown text={'The colors are in `src/theme.css:12`, see README.md and `src/gone.ts`.\n\n```\nsrc/theme.css:1\n```'} />
      </PathLinksContext.Provider>,
    );
    const link = await screen.findByRole('link', { name: 'src/theme.css:12' });
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith('src/theme.css', 12);
    await screen.findByRole('link', { name: 'README.md' });
    expect(screen.queryByRole('link', { name: 'src/gone.ts' })).toBeNull();
    // A code block is code, not links.
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(asked.batches).toHaveLength(1);
    expect(asked.batches[0]!.sort()).toEqual(['README.md', 'src/gone.ts', 'src/theme.css']);
  });

  it('outside a conversation, stays as it was', () => {
    render(<Markdown text="See `src/theme.css:12`." />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('src/theme.css:12').tagName).toBe('CODE');
  });

  it('in a step, opens the file where the step was, and the rest of the row still opens the step', async () => {
    asked.there = new Set(['src/theme.css']);
    const openFile = vi.fn();
    render(
      <PathLinksContext.Provider value={{ cwd: '/code/app', openFile, lines: { e1: 9 } }}>
        <ToolCallView call={{ id: 'r1', name: 'Read', input: { file_path: '/code/app/src/theme.css', offset: 40, limit: 10 }, result: { type: 'tool_result', tool_use_id: 'r1', content: 'x' } }} cwd="/code/app" running={false} />
        <ToolCallView call={{ id: 'e1', name: 'Edit', input: { file_path: '/code/app/src/theme.css', old_string: 'a', new_string: 'b' }, result: { type: 'tool_result', tool_use_id: 'e1', content: 'ok' } }} cwd="/code/app" running={false} />
      </PathLinksContext.Provider>,
    );
    const links = await screen.findAllByRole('link', { name: /theme\.css/ });
    fireEvent.click(links[0]!);
    expect(openFile).toHaveBeenLastCalledWith('src/theme.css', 40);
    fireEvent.click(links[1]!);
    expect(openFile).toHaveBeenLastCalledWith('src/theme.css', 9);
    const toggle = screen.getByRole('button', { name: 'Edit src/theme.css' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
  });
});

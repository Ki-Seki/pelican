// @vitest-environment jsdom
// Run in terminal, on a shell's commands in a reply: offered where a terminal can run them, asked
// about in place first, and sent to a new terminal only once Run is pressed.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_LIMITS } from '../src/shared/terminal';
import { Markdown } from '../src/web/components/Markdown';
import { RunInTerminal } from '../src/web/lib/terminals';

afterEach(cleanup);

const reply = (text: string, run?: (command: string) => void) => render(
  <RunInTerminal.Provider value={run}><Markdown text={text} /></RunInTerminal.Provider>,
);

describe('Run in terminal', () => {
  it('runs a shell’s commands once asked, as they are written, and Cancel or Esc takes the question back', () => {
    const run = vi.fn();
    reply('Check it:\n\n```bash\nnpm test\nnpm run lint\n```\n', run);
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }));
    expect(screen.getByText('Run in a new terminal?')).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Run in a new terminal?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }));
    // Esc takes it back, and goes no further (cancelled, it does not stop Claude).
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Run' }), { key: 'Escape' })).toBe(false);
    expect(screen.queryByText('Run in a new terminal?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(run).toHaveBeenCalledWith('npm test\nnpm run lint');
  });

  it('is offered for a shell’s code only, where a terminal runs, and for what a terminal takes', () => {
    reply('```bash\nls\n```\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```');
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
    cleanup();
    reply('```sh\nls\n```\n\n```zsh\nls\n```\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```', vi.fn());
    expect(screen.getAllByRole('button', { name: 'Run in terminal' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(4);
    cleanup();
    reply(`\`\`\`bash\n${'x'.repeat(TERMINAL_LIMITS.command + 1)}\n\`\`\``, vi.fn());
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
  });
});

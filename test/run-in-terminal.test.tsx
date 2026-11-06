// @vitest-environment jsdom
// Run in terminal, on a shell's commands in Claude's reply: offered where a terminal can run them
// and only in the reply, for a command that shows all it holds, asked about in place first, and
// sent to a new terminal only once Run is pressed.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commandRunnable, TERMINAL_LIMITS } from '../src/shared/terminal';
import { Markdown } from '../src/web/components/Markdown';
import { InReply, RunInTerminal } from '../src/web/lib/terminals';

afterEach(cleanup);

const reply = (text: string, run?: (command: string) => void, inReply = true) => render(
  <RunInTerminal.Provider value={run}><InReply.Provider value={inReply}><Markdown text={text} /></InReply.Provider></RunInTerminal.Provider>,
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

  it('is offered in Claude’s reply only: not on a file’s Markdown, a tool’s or a subagent’s output, a plan or a result', () => {
    reply('```bash\nls\n```', vi.fn(), false);
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('is offered only for a command that shows all it holds', () => {
    // What reads as an echo, while the shell's line editor would take the control characters as
    // keys (Ctrl+A, Ctrl+K, Esc, a carriage return), or a direction override turns it around.
    for (const hidden of ["echo 'safe'\u0001\u000btouch pwned", 'echo safe\u001b[201~', 'echo safe\rtouch pwned', 'echo \u202eexe.dab\u202c', 'ls\u0085', 'ls\u007f']) {
      expect(commandRunnable(hidden)).toBe(false);
      reply(`\`\`\`bash\n${hidden}\n\`\`\``, vi.fn());
      expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
      cleanup();
    }
    // Tabs, lines and any language's letters are what they look like.
    expect(commandRunnable('printf "a\tb"\ncd 文档 && ls')).toBe(true);
    // A reply written with Windows' line ends runs as it shows.
    const run = vi.fn();
    reply('```bash\r\nnpm test\r\nnpm run lint\r\n```', run);
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(run).toHaveBeenCalledWith('npm test\nnpm run lint');
  });
});

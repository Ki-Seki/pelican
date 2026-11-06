// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { revealHidden } from '../src/shared/hidden';
import type { PermissionRequest } from '../src/shared/protocol';

const { PermissionCard } = await import('../src/web/components/PermissionCard');

afterEach(cleanup);

const bash = (extra: Partial<PermissionRequest>): PermissionRequest => ({
  id: 'p1', sessionId: 's1', toolName: 'Bash', createdAt: Date.now(),
  input: { command: 'rm -rf "$S/$d"; mkdir -p "$S/$d"', description: 'Extract base, no-group and with-group trees' },
  ...extra,
});

describe('an approval', () => {
  it('says Claude’s few words on a command once, also when Claude Code passes them as its own line', () => {
    render(<PermissionCard sessionId="s1" request={bash({ agent: 'a subagent', description: 'Extract base, no-group and with-group trees', reason: 'Dangerous rm operation on possibly-empty variable path' })} />);
    expect(screen.getAllByText('Extract base, no-group and with-group trees')).toHaveLength(1);
    expect(screen.getByText('From a subagent')).toBeTruthy();
    expect(screen.getByText('Dangerous rm operation on possibly-empty variable path')).toBeTruthy();
  });

  it('keeps a line of Claude Code’s own that says more than the command’s words', () => {
    render(<PermissionCard sessionId="s1" request={bash({ description: 'This command writes outside the project' })} />);
    expect(screen.getByText('Extract base, no-group and with-group trees')).toBeTruthy();
    expect(screen.getByText('This command writes outside the project')).toBeTruthy();
  });

  it('does not repeat a command’s first line as its line when Claude gave no words', () => {
    render(<PermissionCard sessionId="s1" request={bash({ input: { command: 'npm test' }, description: 'npm test' })} />);
    expect(screen.getAllByText('npm test')).toHaveLength(1);
  });
});

describe('an approval to send a file', () => {
  const request = (input: Record<string, unknown>): PermissionRequest => ({
    id: 'p1', sessionId: 's1', toolName: 'SendUserFile', createdAt: Date.now(), input, reason: 'Path is outside allowed working directories',
  });

  it('says what Claude wants to send you, by each file’s path, with its caption, not as raw input', () => {
    render(<PermissionCard sessionId="s1" cwd="/Users/ada/work" request={request({ files: ['/tmp/notes.txt', '/Users/ada/work/report.md'], caption: 'Notes from outside the folder', status: 'proactive' })} />);
    expect(screen.getByText('Claude wants to send you 2 files')).toBeTruthy();
    expect(screen.getByText('/tmp/notes.txt')).toBeTruthy();
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.getByText('Notes from outside the folder')).toBeTruthy();
    expect(screen.getByText('Path is outside allowed working directories')).toBeTruthy();
    expect(screen.queryByText(/"status"/)).toBeNull();
  });

  it('takes one file named on its own, and warns of characters that hide in a path', () => {
    render(<PermissionCard sessionId="s1" cwd="/Users/ada/work" request={request({ files: '/tmp/re\u202Etxt.md' })} />);
    expect(screen.getByText('Claude wants to send you a file')).toBeTruthy();
    expect(screen.getByText('/tmp/re⟨U+202E⟩txt.md')).toBeTruthy();
    expect(screen.getByText(/invisible or direction-changing characters/)).toBeTruthy();
  });

  it('names a screenshot as macOS does, keeps its caption’s emoji whole, and warns of nothing', () => {
    const screenshot = '/Users/ada/Desktop/Screenshot 2026-11-06 at 10.00.00\u202fAM.png';
    render(<PermissionCard sessionId="s1" cwd="/Users/ada/work" request={request({ files: [screenshot], caption: 'Here it is \u2714\ufe0f' })} />);
    // Exactly: a matcher's own spacing would make the narrow space a plain one.
    expect(screen.getByRole('listitem').textContent).toBe(screenshot);
    expect(screen.getByText('Here it is \u2714\ufe0f')).toBeTruthy();
    expect(screen.queryByText(/invisible or direction-changing characters/)).toBeNull();
    // The name its card and its download take is its own.
    expect(revealHidden('Screenshot 2026-11-06 at 10.00.00\u202fAM.png')).toEqual({ text: 'Screenshot 2026-11-06 at 10.00.00\u202fAM.png', hidden: false });
  });
});

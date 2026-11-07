// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { revealHidden } from '../src/shared/hidden';
import type { PermissionRequest } from '../src/shared/protocol';

const { PermissionCard } = await import('../src/web/components/PermissionCard');
const { api } = await import('../src/web/lib/api');

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

  it('reads a caption as words: a script’s joiners stay, what turns it around is shown and warned of', () => {
    render(<PermissionCard sessionId="s1" cwd="/Users/ada/work" request={request({ files: ['/Users/ada/work/a.png'], caption: '\u0646\u0627\u0645\u0647\u200c\u0647\u0627' })} />);
    expect(screen.getByText('\u0646\u0627\u0645\u0647\u200c\u0647\u0627')).toBeTruthy();
    expect(screen.queryByText(/invisible or direction-changing characters/)).toBeNull();
    cleanup();
    render(<PermissionCard sessionId="s1" cwd="/Users/ada/work" request={request({ files: ['/Users/ada/work/a.png'], caption: 'Your invoice \u2714\ufe0f\u202efdp.exe' })} />);
    expect(screen.getByText('Your invoice \u2714\ufe0f⟨U+202E⟩fdp.exe')).toBeTruthy();
    expect(screen.getByText(/invisible or direction-changing characters/)).toBeTruthy();
  });
});

describe('Claude’s questions', () => {
  const asked = (questions: Array<Record<string, unknown>>): PermissionRequest => ({
    id: 'q1', sessionId: 's1', toolName: 'AskUserQuestion', createdAt: Date.now(), input: { questions },
  });
  const QUESTIONS = [
    { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'What the rest uses' }, { label: 'SQLite' }] },
    { question: 'Which environments?', multiSelect: true, options: [{ label: 'dev' }, { label: 'staging' }, { label: 'production' }] },
  ];
  /** A computer's screen, with a pointer that hovers: a keyboard, very likely. */
  const computer = (on: boolean) => {
    window.matchMedia = ((query: string) => ({ matches: on && query === '(hover: hover) and (pointer: fine)', media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    computer(false);
    vi.restoreAllMocks();
  });

  it('on a computer, take the keys as they come, and 1 to 9 pick by number, for the first question not answered yet', async () => {
    computer(true);
    const decide = vi.spyOn(api, 'decide').mockResolvedValue({ ok: true } as never);
    render(<PermissionCard sessionId="s1" request={asked(QUESTIONS)} />);
    const card = screen.getByRole('group', { name: 'Claude’s questions' });
    expect(document.activeElement).toBe(card);
    // Each option's number, faintly beside it.
    expect(screen.getByRole('button', { name: /^SQLite/ }).getAttribute('aria-keyshortcuts')).toBe('2');
    expect(screen.getByRole('button', { name: /^SQLite/ }).textContent).toBe('SQLite2');
    fireEvent.keyDown(card, { key: '2' });
    expect(screen.getByRole('button', { name: /^SQLite/ }).getAttribute('aria-pressed')).toBe('true');
    // The next number goes to the next question, where several may be picked.
    fireEvent.keyDown(card, { key: '1' });
    fireEvent.keyDown(card, { key: '2' });
    fireEvent.keyDown(card, { key: '9' });
    // Clicks on an approval count once it has been there a moment.
    const later = performance.now() + 1000;
    vi.spyOn(performance, 'now').mockReturnValue(later);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(decide).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which database?': 'SQLite', 'Which environments?': 'dev, staging' } } });
  });

  it('pick for the question the keys are in; a letter starts its Other, where a number is a number', () => {
    computer(true);
    render(<PermissionCard sessionId="s1" request={asked(QUESTIONS)} />);
    const second = screen.getByRole('button', { name: /^production/ });
    second.focus();
    fireEvent.keyDown(second, { key: '1' });
    expect(screen.getByRole('button', { name: /^dev/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^Postgres/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Postgres/ }), { key: 'M' });
    const others = screen.getAllByPlaceholderText('Other…') as HTMLInputElement[];
    expect(others[0]!.value).toBe('M');
    expect(document.activeElement).toBe(others[0]);
    fireEvent.keyDown(others[0]!, { key: '2' });
    expect(screen.getByRole('button', { name: /^SQLite/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('leave the keys where something is being typed, and show no numbers on a phone', () => {
    computer(true);
    const box = document.createElement('textarea');
    box.setAttribute('aria-label', 'Message Claude');
    box.value = 'Half a thought';
    document.body.append(box);
    box.focus();
    render(<PermissionCard sessionId="s1" request={asked(QUESTIONS)} />);
    expect(document.activeElement).toBe(box);
    box.remove();
    cleanup();
    computer(false);
    render(<PermissionCard sessionId="s1" request={asked(QUESTIONS)} />);
    expect(screen.getByRole('button', { name: /^SQLite/ }).textContent).toBe('SQLite');
    expect(document.activeElement).not.toBe(screen.getByRole('group', { name: 'Claude’s questions' }));
  });
});

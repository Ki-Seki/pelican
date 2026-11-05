import { describe, expect, it } from 'vitest';

import type { PermissionRequest } from '../src/shared/protocol';
import { announcement, askedFor, plainText } from '../src/web/lib/announce';
import { titleFor } from '../src/web/lib/title';

const edit: PermissionRequest = {
  id: 'p1', sessionId: 's', toolName: 'Edit', input: { file_path: '/code/acme/src/settings/Settings.tsx' }, canRemember: true, createdAt: 0,
};

describe('what screen readers are told', () => {
  it('says what Claude asks for in the card’s words, and how to answer', () => {
    expect(askedFor(edit, '/code/acme')).toBe('Claude wants to edit Settings.tsx. Allow, Always allow or Deny.');
    expect(askedFor({ ...edit, canRemember: false }, '/code/acme')).toBe('Claude wants to edit Settings.tsx. Allow or Deny.');
    expect(askedFor(edit, '/code/acme', true)).toBe('Claude wants to edit Settings.tsx');
    expect(askedFor({ ...edit, toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which database?' }] } })).toBe('Claude has a question. Which database?');
    expect(askedFor({ ...edit, toolName: 'ExitPlanMode', input: { plan: '...' } })).toBe('Claude’s plan is ready for review.');
  });

  it('speaks once per change: a new request, a turn that ended', () => {
    const idle = { permissions: [], busy: false };
    const working = { permissions: [], busy: true };
    expect(announcement(idle, working)).toBeUndefined();
    expect(announcement(working, { permissions: [edit], busy: true }, '/code/acme')).toMatch(/^Claude wants to edit Settings\.tsx/);
    expect(announcement({ permissions: [edit], busy: true }, { permissions: [edit], busy: true })).toBeUndefined();
    expect(announcement(working, { ...idle, reply: '**Done.** The `toggle` is [in place](x).' })).toBe('Claude replied. Done. The toggle is in place.');
    expect(announcement(working, { ...idle, error: 'API Error: 529 Overloaded' })).toBe('Claude stopped. API Error: 529 Overloaded');
    expect(announcement(working, idle)).toBe('Claude finished.');
  });

  it('reads a long reply’s beginning, as words', () => {
    const said = announcement({ permissions: [], busy: true }, { permissions: [], busy: false, reply: `# Title\n\n${'word '.repeat(200)}` })!;
    expect(said.length).toBeLessThan(330);
    expect(said).not.toContain('#');
    expect(plainText('- one\n- two\n\n```ts\nconst a = 1;\n```')).toBe('one two const a = 1;');
  });
});

describe('the tab title', () => {
  it('names the open session after how many need you', () => {
    expect(titleFor(undefined, 0)).toBe('Pelican');
    expect(titleFor('Fix the login test', 0)).toBe('Fix the login test · Pelican');
    expect(titleFor('Fix the login test', 2)).toBe('(2) Fix the login test · Pelican');
    expect(titleFor(undefined, 1)).toBe('(1) Pelican');
  });
});

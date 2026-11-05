// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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

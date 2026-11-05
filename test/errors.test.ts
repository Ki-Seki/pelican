import { describe, expect, it } from 'vitest';

import { errorLine, plainError, stoppedBecause } from '../src/shared/errors';
import type { ChatMessage } from '../src/shared/protocol';
import { buildItems } from '../src/web/lib/turns';

describe('Claude Code’s errors in plain words', () => {
  it('says what happened and what to do, without the API’s JSON', () => {
    expect(plainError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('Anthropic’s API is overloaded. Try again in a moment.');
    expect(plainError('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBe('Anthropic’s API had a problem. Try again in a moment.');
    expect(plainError('Prompt is too long')).toBe('The conversation is too long for the model. Send /compact to shorten it, or start a new session.');
    expect(plainError('Not logged in · Please run /login', 'studio')).toBe('Claude Code is not signed in on studio. Run claude in a terminal there and sign in with /login.');
    expect(plainError('Invalid API key · Fix external API key')).toMatch(/^Claude Code is not signed in on your computer/);
    expect(plainError("You've hit your limit · resets 3pm (Europe/London)")).toBe('You have reached your usage limit. It resets 3pm (Europe/London).');
    expect(plainError("You've hit your 5-hour limit · resets 6pm · progress saved")).toBe('You have reached your 5-hour limit. It resets 6pm.');
    expect(plainError("You've hit your usage credit limit")).toBe('You have reached your usage credit limit.');
    expect(plainError("You've hit your weekly limit · resets Mon 9am")).toBe('You have reached your weekly limit. It resets Mon 9am.');
    expect(plainError('Something else entirely')).toBeUndefined();
  });

  it('tells someone signed out to sign in on the computer Claude Code runs on, whatever its words', () => {
    expect(plainError('OAuth token revoked', 'studio', 'authentication_failed')).toBe('Claude Code is not signed in on studio. Run claude in a terminal there and sign in with /login.');
    expect(plainError('Something else entirely', 'studio', 'account_on_hold')).toBeUndefined();
    // In the conversation the line stays: it says what happened then, and what to do there.
    expect(errorLine('Not logged in · Please run /login', 'studio', 'authentication_failed'))
      .toBe('Claude Code was not signed in on studio, so Claude did not answer. Run claude in a terminal there and sign in with /login.');
    expect(errorLine('API Error: 529 {"type":"error"}', 'studio')).toBe('Anthropic’s API is overloaded. Try again in a moment.');
  });

  it('says in a few words why a turn stopped, for the session list', () => {
    expect(stoppedBecause('Not logged in · Please run /login', 'authentication_failed')).toBe('not signed in');
    expect(stoppedBecause('Prompt is too long', 'invalid_request')).toBe('conversation too long');
    expect(stoppedBecause("You've hit your limit · resets 3pm", 'rate_limit')).toBe('usage limit reached');
    expect(stoppedBecause('Request rejected', 'overloaded')).toBe('API overloaded');
    expect(stoppedBecause('Something new')).toBe('API error');
  });

  it('shows a failed API call once, as an error line, not as Claude’s reply', () => {
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Go' }] },
      { uuid: 'a1', role: 'assistant', apiError: true, model: '<synthetic>', blocks: [{ type: 'text', text: 'API Error: 529 {"type":"error"}' }] },
    ];
    expect(buildItems(messages).at(-1)).toEqual({ kind: 'notice', key: 'a1', tone: 'error', text: 'Anthropic’s API is overloaded. Try again in a moment.', next: 'retry' });
    const signedOut: ChatMessage = { uuid: 'a2', role: 'assistant', apiError: true, error: 'authentication_failed', model: '<synthetic>', blocks: [{ type: 'text', text: 'Not logged in · Please run /login' }] };
    expect(buildItems([messages[0]!, signedOut], 'studio').at(-1)).toMatchObject({ tone: 'error', text: expect.stringMatching(/^Claude Code was not signed in on studio, so Claude did not answer\. Run claude/) });
  });

  it('shows what Claude Code adds itself as notes: a command’s output, hook feedback', () => {
    const messages: ChatMessage[] = [
      { uuid: 's1', role: 'system', blocks: [{ type: 'text', text: '<command-name>/cost</command-name>\n<command-args></command-args>' }] },
      { uuid: 's2', role: 'system', blocks: [{ type: 'text', text: '<local-command-stdout>Total cost: $0.12</local-command-stdout>' }] },
      { uuid: 's3', role: 'system', blocks: [{ type: 'text', text: 'Prompt blocked by a hook: no secrets' }] },
    ];
    expect(buildItems(messages)).toEqual([
      { kind: 'user', key: 's1', text: '', images: [], files: [], command: { name: '/cost', args: '' } },
      { kind: 'notice', key: 's2', tone: 'output', text: 'Total cost: $0.12' },
      { kind: 'notice', key: 's3', tone: 'info', text: 'Prompt blocked by a hook: no secrets' },
    ]);
  });
});

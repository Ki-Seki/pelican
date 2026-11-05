import { describe, expect, it } from 'vitest';

import { plainError } from '../src/shared/errors';
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
    expect(plainError('Something else entirely')).toBeUndefined();
  });

  it('shows a failed API call once, as an error line, not as Claude’s reply', () => {
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Go' }] },
      { uuid: 'a1', role: 'assistant', apiError: true, model: '<synthetic>', blocks: [{ type: 'text', text: 'API Error: 529 {"type":"error"}' }] },
    ];
    expect(buildItems(messages).at(-1)).toEqual({ kind: 'notice', key: 'a1', tone: 'error', text: 'Anthropic’s API is overloaded. Try again in a moment.' });
  });

  it('shows what Claude Code adds itself as notes: a command’s output, hook feedback', () => {
    const messages: ChatMessage[] = [
      { uuid: 's1', role: 'system', blocks: [{ type: 'text', text: '<command-name>/cost</command-name>\n<command-args></command-args>' }] },
      { uuid: 's2', role: 'system', blocks: [{ type: 'text', text: '<local-command-stdout>Total cost: $0.12</local-command-stdout>' }] },
      { uuid: 's3', role: 'system', blocks: [{ type: 'text', text: 'Prompt blocked by a hook: no secrets' }] },
    ];
    expect(buildItems(messages)).toEqual([
      { kind: 'user', key: 's1', text: '', images: [], command: { name: '/cost', args: '' } },
      { kind: 'notice', key: 's2', tone: 'output', text: 'Total cost: $0.12' },
      { kind: 'notice', key: 's3', tone: 'info', text: 'Prompt blocked by a hook: no secrets' },
    ]);
  });
});

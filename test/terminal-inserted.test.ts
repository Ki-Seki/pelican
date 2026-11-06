// @vitest-environment jsdom
// Text a computer puts into the terminal without keys (src/web/lib/terminal-input.ts, insertedText):
// xterm in screen reader mode sends what keys type and what input methods compose, and leaves the
// rest in its field; this sends that rest, once, and nothing xterm sends itself.
import { describe, expect, it } from 'vitest';

import { insertedText } from '../src/web/lib/terminal-input';

function field() {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  const taken: string[] = [];
  const stop = insertedText(el, (text) => taken.push(text));
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = type === 'input' ? new InputEvent('input', init) : type.startsWith('key') ? new KeyboardEvent(type, init) : type.startsWith('composition') ? new CompositionEvent(type, init) : new FocusEvent(type);
    el.dispatchEvent(event);
  };
  return { taken, fire, stop };
}

describe('text put in without keys', () => {
  it('goes to the shell: an emoji picker’s, dictation’s', () => {
    const { taken, fire } = field();
    fire('input', { inputType: 'insertText', data: '\u{1f680}' });
    fire('input', { inputType: 'insertText', data: 'dictated words' });
    expect(taken).toEqual(['\u{1f680}', 'dictated words']);
  });

  it('leaves to xterm what a key typed, also held down, and sends what comes once the key is up', () => {
    const { taken, fire } = field();
    fire('keydown', { key: 'a' });
    fire('input', { inputType: 'insertText', data: 'a' });
    fire('keydown', { key: 'a', repeat: true });
    fire('input', { inputType: 'insertText', data: 'a' });
    fire('keyup', { key: 'a' });
    expect(taken).toEqual([]);
    fire('input', { inputType: 'insertText', data: '\u{1f600}' });
    expect(taken).toEqual(['\u{1f600}']);
  });

  it('leaves to xterm what an input method composes, and the text it puts in as it ends', () => {
    const { taken, fire } = field();
    fire('compositionstart');
    fire('input', { inputType: 'insertCompositionText', data: 'zhong', isComposing: true });
    fire('input', { inputType: 'insertText', data: '中', isComposing: true });
    fire('compositionend', { data: '中' });
    fire('input', { inputType: 'insertText', data: '中' });
    expect(taken).toEqual([]);
  });

  it('takes nothing of a paste (cleaned and sent as one) or after the field lost a key’s release', () => {
    const { taken, fire, stop } = field();
    fire('input', { inputType: 'insertFromPaste', data: 'pasted' });
    fire('keydown', { key: 'Meta' });
    fire('blur');
    fire('input', { inputType: 'insertText', data: 'x' });
    expect(taken).toEqual(['x']);
    stop();
    fire('input', { inputType: 'insertText', data: 'y' });
    expect(taken).toEqual(['x']);
  });
});

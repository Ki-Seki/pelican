// @vitest-environment jsdom
// Text a computer puts into the terminal without keys (src/web/lib/terminal-input.ts, insertedText):
// xterm in screen reader mode sends what keys type and what input methods compose, and leaves the
// rest in its field; this sends that rest, once, and nothing xterm sends itself. The events come as
// a browser fires them: a key that types fires keydown, keypress, then input.
import { describe, expect, it } from 'vitest';

import { insertedText } from '../src/web/lib/terminal-input';

function field() {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  const taken: string[] = [];
  const stop = insertedText(el, (text) => taken.push(text));
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = type === 'input' ? new InputEvent('input', init) : type.startsWith('key') ? new KeyboardEvent(type, init) : type.startsWith('composition') ? new CompositionEvent(type, init) : new FocusEvent(type);
    // jsdom takes no keyCode as it makes the event.
    if ('keyCode' in init) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
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
    for (const repeat of [false, true, true]) {
      fire('keydown', { key: 'a', repeat });
      fire('keypress', { key: 'a', charCode: 97 });
      fire('input', { inputType: 'insertText', data: 'a' });
    }
    fire('keyup', { key: 'a' });
    expect(taken).toEqual([]);
    fire('input', { inputType: 'insertText', data: '\u{1f600}' });
    expect(taken).toEqual(['\u{1f600}']);
    // Enter types no text into the field, and what comes after it is the picker's.
    fire('keydown', { key: 'Enter' });
    fire('keypress', { key: 'Enter', charCode: 13 });
    fire('input', { inputType: 'insertLineBreak' });
    fire('keyup', { key: 'Enter' });
    fire('input', { inputType: 'insertText', data: '\u{1f680}' });
    expect(taken).toEqual(['\u{1f600}', '\u{1f680}']);
  });

  it('sends what comes while a key that types nothing is held: Shift, Ctrl, Alt, Cmd', () => {
    const { taken, fire } = field();
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      fire('keydown', { key });
      fire('input', { inputType: 'insertText', data: key[0]! });
      fire('keyup', { key });
    }
    expect(taken).toEqual(['S', 'C', 'A', 'M']);
    // And with Shift held, a key that types: xterm's.
    fire('keydown', { key: 'Shift' });
    fire('keydown', { key: 'B' });
    fire('keypress', { key: 'B', charCode: 66 });
    fire('input', { inputType: 'insertText', data: 'B' });
    expect(taken).toEqual(['S', 'C', 'A', 'M']);
  });

  it('leaves to xterm a key an input method takes, whose text xterm reads from its field', () => {
    const { taken, fire } = field();
    fire('keydown', { key: 'Process', keyCode: 229 });
    fire('input', { inputType: 'insertText', data: '\uff0c' });
    fire('keyup', { key: ',' });
    expect(taken).toEqual([]);
    fire('input', { inputType: 'insertText', data: '\u{1f680}' });
    expect(taken).toEqual(['\u{1f680}']);
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

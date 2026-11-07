// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { StartDefaults } from '../src/shared/defaults';
import type { ModelOption } from '../src/shared/protocol';
import { defaultChange, forModel, fromDefaults, modelNote, modelSources, modeNote } from '../src/web/lib/defaults';
import { BUILT_IN } from './start-defaults';

const MODELS: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, supportsAuto: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: false, supportsAuto: true, resolvedModel: 'claude-sonnet-5-5' },
  { value: 'haiku', label: 'Haiku', description: '', efforts: [], supportsFast: false, supportsAuto: false, resolvedModel: 'claude-haiku-5-5' },
];
const with_ = (patch: Partial<StartDefaults>): StartDefaults => ({ ...BUILT_IN, ...patch });

afterEach(() => localStorage.clear());

describe('what a new session starts with, in the composer’s terms', () => {
  it('is Claude Code’s: the default model, its own effort, no fast mode or Ultracode, Auto', () => {
    expect(fromDefaults(BUILT_IN, MODELS)).toEqual({ model: 'default', fast: false, ultracode: false, permissionMode: 'auto' });
  });

  it('is what the files say, with the effort and fast mode of the model and Manual where it has no Auto', () => {
    const defaults = with_({
      model: { value: 'claude-sonnet-5-5', source: 'user' },
      effort: { byModel: { 'claude-sonnet-5-5': { level: 'low', source: 'user' }, 'claude-opus-5-5': { level: 'xhigh', source: 'user' } } },
      fast: { value: true, source: 'user', perSession: false },
    });
    // The id Claude Code keeps is named as the picker names it.
    expect(fromDefaults(defaults, MODELS)).toEqual({ model: 'sonnet', effort: 'low', fast: false, ultracode: false, permissionMode: 'auto' });
    expect(forModel(defaults, 'default', MODELS)).toEqual({ effort: 'xhigh', fast: true, ultracode: false, permissionMode: 'auto' });
    expect(forModel(defaults, 'haiku', MODELS)).toEqual({ fast: false, ultracode: false, permissionMode: 'default' });
  });

  it('pays no heed to the defaults this browser kept before 0.5.0', () => {
    localStorage.setItem('pelican:settings', JSON.stringify({ model: 'haiku', effort: 'high', ultracode: true, permissionMode: 'plan' }));
    expect(fromDefaults(BUILT_IN, MODELS)).toEqual({ model: 'default', fast: false, ultracode: false, permissionMode: 'auto' });
  });
});

describe('a pick in a session’s model sheet, saved as Claude Code’s commands save it', () => {
  const now = { model: 'default', effort: 'high', fast: false, ultracode: false, permissionMode: 'auto' as const };

  it('saves a model as /model does, and only the model when the effort and fast mode follow it', () => {
    expect(defaultChange(now, { ...now, model: 'sonnet', effort: 'low' })).toEqual({ model: 'sonnet' });
    expect(defaultChange({ ...now, model: 'sonnet' }, { ...now, model: 'default' })).toEqual({ model: 'default' });
  });

  it('saves an effort for the model as /effort does: Default takes it out, Max stays with the session', () => {
    expect(defaultChange(now, { ...now, effort: 'xhigh' })).toEqual({ effort: { model: 'default', level: 'xhigh' } });
    expect(defaultChange(now, { ...now, effort: undefined })).toEqual({ effort: { model: 'default', level: null } });
    expect(defaultChange(now, { ...now, effort: 'max' })).toBeUndefined();
  });

  it('saves fast mode as /fast does, unless Claude Code’s settings keep it per session', () => {
    expect(defaultChange(now, { ...now, fast: true })).toEqual({ fast: true });
    expect(defaultChange(now, { ...now, fast: true }, true)).toBeUndefined();
  });

  it('saves neither Ultracode nor the mode, which are the session’s alone', () => {
    expect(defaultChange(now, { ...now, ultracode: true })).toBeUndefined();
    expect(defaultChange(now, { ...now, permissionMode: 'plan' })).toBeUndefined();
    expect(defaultChange(now, { ...now, permissionMode: 'bypassPermissions' })).toBeUndefined();
  });
});

describe('where the values come from, said where it is not plain', () => {
  it('names the files that set what new sessions start on', () => {
    expect(modelSources(BUILT_IN, MODELS)).toBe('Claude Code’s defaults');
    expect(modelSources(with_({ model: { value: 'sonnet', source: 'user' }, ultracode: { value: true, source: 'managed', workflows: true } }), MODELS))
      .toBe('Your Claude Code settings, Managed settings');
  });

  it('says when a folder’s or managed settings decide, and what the user’s own say', () => {
    expect(modelNote(BUILT_IN, MODELS)).toBeUndefined();
    expect(modelNote(with_({ model: { value: 'haiku', source: 'project', user: 'sonnet' } }), MODELS))
      .toBe('This folder’s .claude/settings.json starts sessions here with Haiku (yours: Sonnet).');
    expect(modelNote(with_({ fast: { value: false, source: 'user', perSession: true } }), MODELS)).toMatch(/without fast mode/);
    expect(modelNote(with_({ ultracode: { value: true, source: 'user', workflows: true } }), MODELS)).toBe('Your Claude Code settings turn Ultracode on for every session.');
  });

  it('says what of a folder’s own settings waits for it to be trusted, each in its sheet', () => {
    const waiting = with_({ waiting: ['model', 'fast', 'ultracode', 'mode'] });
    expect(modelNote(waiting, MODELS)).toBe('This folder’s own settings for the model, fast mode and Ultracode wait until you trust the folder, which Pelican asks before the session starts.');
    expect(modeNote(waiting, MODELS[0])).toBe('This folder’s own settings for the mode wait until you trust the folder, which Pelican asks before the session starts.');
    expect(modelNote(with_({ waiting: ['mode'] }), MODELS)).toBeUndefined();
    expect(modeNote(with_({ waiting: ['effort'] }), MODELS[0])).toBeUndefined();
  });

  it('says plainly when new sessions start in Bypass, and when a folder asks for a mode Claude Code does not take from it', () => {
    expect(modeNote(BUILT_IN, MODELS[0])).toBeUndefined();
    expect(modeNote(with_({ permissionMode: { value: 'bypassPermissions', source: 'user' } }), MODELS[0]))
      .toBe('Your Claude Code settings start new sessions in Bypass permissions: Claude runs everything without asking.');
    expect(modeNote(with_({ permissionMode: { value: 'default', source: 'local', ignored: { mode: 'bypassPermissions', source: 'local', why: 'folder' } } }), MODELS[0]))
      .toMatch(/^This folder’s \.claude\/settings\.local\.json asks for Bypass permissions, which Claude Code takes only from your own settings, so sessions here start in Manual\.$/);
    expect(modeNote(with_({ permissionMode: { value: 'plan', source: 'project', user: 'acceptEdits' } }), MODELS[0]))
      .toBe('This folder’s .claude/settings.json starts sessions here in Plan (yours: Accept edits).');
  });
});

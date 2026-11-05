import { describe, expect, it } from 'vitest';

import type { ModelOption } from '../src/shared/protocol';
import { fromRecorded } from '../src/web/lib/settings';

const model = (value: string, resolvedModel?: string): ModelOption => ({ value, label: value, description: '', efforts: [], supportsFast: true, ...(resolvedModel ? { resolvedModel } : {}) });
const MODELS = [model('default', 'claude-opus-5-5'), model('opus', 'claude-opus-5-5'), model('sonnet', 'claude-sonnet-5-5'), model('claude-opus-5')];

describe('fromRecorded', () => {
  it('names the recorded model id as the picker does: its own entry, else an alias other than Default', () => {
    expect(fromRecorded({ model: 'claude-opus-5-5' }, MODELS)?.model).toBe('opus');
    expect(fromRecorded({ model: 'claude-sonnet-5-5' }, MODELS)?.model).toBe('sonnet');
    expect(fromRecorded({ model: 'claude-opus-5' }, MODELS)?.model).toBe('claude-opus-5');
    expect(fromRecorded({ model: 'claude-haiku-9' }, MODELS)?.model).toBe('claude-haiku-9');
    expect(fromRecorded({ model: 'claude-opus-5-5' }, [model('default', 'claude-opus-5-5')])?.model).toBe('default');
  });

  it('keeps the name picked for the session while it is still the model the session runs', () => {
    expect(fromRecorded({ model: 'claude-opus-5-5' }, MODELS, 'default')?.model).toBe('default');
    expect(fromRecorded({ model: 'claude-opus-5-5' }, MODELS, 'opus')?.model).toBe('opus');
    // The session moved on (in the terminal, say): the model it runs wins.
    expect(fromRecorded({ model: 'claude-sonnet-5-5' }, MODELS, 'opus')?.model).toBe('sonnet');
    // Before the model list arrives, only the same id counts.
    expect(fromRecorded({ model: 'claude-opus-5-5' }, undefined, 'opus')?.model).toBe('claude-opus-5-5');
  });

  it('carries the rest over, Bypass included: the mode is the session’s own', () => {
    expect(fromRecorded({ effort: 'max', fast: false, ultracode: true, permissionMode: 'plan' }, MODELS)).toEqual({ effort: 'max', fast: false, ultracode: true, permissionMode: 'plan' });
    expect(fromRecorded({ model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' }, MODELS)).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' });
    expect(fromRecorded({}, MODELS)).toBeUndefined();
    expect(fromRecorded(undefined, MODELS)).toBeUndefined();
  });
});

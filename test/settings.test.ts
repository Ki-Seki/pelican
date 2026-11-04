import { describe, expect, it } from 'vitest';

import type { ModelOption } from '../src/shared/protocol';
import { fromRecorded } from '../src/web/lib/settings';

const model = (value: string, resolvedModel?: string): ModelOption => ({ value, label: value, description: '', efforts: [], supportsFast: true, ...(resolvedModel ? { resolvedModel } : {}) });
const MODELS = [model('default', 'claude-opus-5-5'), model('opus', 'claude-opus-5-5'), model('sonnet', 'claude-sonnet-5-5'), model('claude-opus-5')];

describe('fromRecorded', () => {
  it('maps the recorded model id back to the picker: Default first, then an alias, then the id itself', () => {
    expect(fromRecorded({ model: 'claude-opus-5-5' }, MODELS)?.model).toBe('default');
    expect(fromRecorded({ model: 'claude-sonnet-5-5' }, MODELS)?.model).toBe('sonnet');
    expect(fromRecorded({ model: 'claude-opus-5' }, MODELS)?.model).toBe('claude-opus-5');
    expect(fromRecorded({ model: 'claude-haiku-9' }, MODELS)?.model).toBe('claude-haiku-9');
  });

  it('carries the rest over, and nothing when nothing was recorded', () => {
    expect(fromRecorded({ effort: 'max', fast: false, ultracode: true, permissionMode: 'plan' }, MODELS)).toEqual({ effort: 'max', fast: false, ultracode: true, permissionMode: 'plan' });
    expect(fromRecorded({}, MODELS)).toBeUndefined();
    expect(fromRecorded(undefined, MODELS)).toBeUndefined();
  });
});

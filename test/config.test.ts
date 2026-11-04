import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function load(env: Record<string, string>) {
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../src/server/config');
}

describe('origins in the config', () => {
  it('keeps web origins and drops anything looser, with a warning', async () => {
    const { config, configWarnings } = await load({
      PELICAN_ALLOWED_ORIGINS: 'https://pelican.example.com, *, null, https:, https://a.example/path, https://a.example;x',
      PELICAN_FRAME_ANCESTORS: "https://*.example.com 'none' https://ok.example",
    });
    expect(config.allowedOrigins).toEqual(['https://pelican.example.com']);
    expect(config.frameAncestors).toEqual(['https://*.example.com', 'https://ok.example']);
    expect(configWarnings).toHaveLength(6);
  });

  it('has a wildcard host only for frames', async () => {
    const { config } = await load({ PELICAN_ALLOWED_ORIGINS: 'https://*.example.com' });
    expect(config.allowedOrigins).toEqual([]);
  });
});

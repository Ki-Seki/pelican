import { describe, expect, it } from 'vitest';

import { plainText } from '../src/server/transcripts';

describe('a reply’s preview in the list', () => {
  it('keeps the characters names are made of, and drops only Markdown’s marks', () => {
    expect(plainText("Found it: `export_rows` looks up each row's owner.")).toBe("Found it: export_rows looks up each row's owner.");
    expect(plainText('Edit `__init__.py`, then __init__.py and snake_case_name')).toBe('Edit __init__.py, then __init__.py and snake_case_name');
    expect(plainText('**Note:** keep *this* and _that_; a > b, 2 * 3 * 4 = 24')).toBe('Note: keep this and that; a > b, 2 * 3 * 4 = 24');
  });

  it('reads Claude Desktop’s pull request tag as the conversation does: nothing on a line of its own, its address among words', () => {
    expect(plainText('The pull request is open.\n<pr-created>https://github.com/acme/app/pull/7</pr-created>')).toBe('The pull request is open.');
    expect(plainText('Done. <pr-created>https://github.com/acme/app/pull/7</pr-created>')).toBe('Done. https://github.com/acme/app/pull/7');
    expect(plainText('Opened <pr-created> https://github.com/acme/app/pull/8 </pr-created> for review.')).toBe('Opened https://github.com/acme/app/pull/8 for review.');
  });

  it('reads headings, quotes, tables, code and links as plain text', () => {
    const reply = '## Result\n\n> All green\n\n| test | ms |\n|---|:--:|\n| login | 42 |\n\n```ts\nrun();\n```\nSee [the log](https://ci.example/run_1).';
    expect(plainText(reply)).toBe('Result All green test ms login 42 run(); See the log.');
  });
});

describe('a reply’s preview in the list, from a reply with one very long line', () => {
  it('takes about as long as the reply is, not its square: the server waits on nothing else meanwhile', async () => {
    // Emphasis marks that never close, after spaces or brackets: field names, a one-line program.
    const line = Array.from({ length: 16_000 }, (_, i) => `_field${i}`).join(', ');
    let started = performance.now();
    expect(plainText(` _a${' _a'.repeat(40_000)}`)).toMatch(/^_a _a/);
    expect(plainText(`(${'(_x, '.repeat(24_000)}`)).toMatch(/^\(\(_x, \(_x,/);
    expect(performance.now() - started).toBeLessThan(1000);

    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readLastTurn } = await import('../src/server/transcripts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-preview-'));
    try {
      const file = path.join(dir, 's.jsonl');
      const at = new Date().toISOString();
      await writeFile(file, `${[
        { type: 'user', uuid: 'u1', timestamp: at, cwd: '/w', message: { role: 'user', content: 'List the fields' } },
        { type: 'assistant', uuid: 'a1', timestamp: at, cwd: '/w', message: { role: 'assistant', content: [{ type: 'text', text: `**Fields:** ${line}` }] } },
      ].map((row) => JSON.stringify(row)).join('\n')}\n`);
      started = performance.now();
      const turn = await readLastTurn(file);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(turn?.preview).toBe(`Fields: ${line}`.slice(0, 160));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

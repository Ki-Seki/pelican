import { describe, expect, it } from 'vitest';

import { plainText } from '../src/server/transcripts';

describe('a reply’s preview in the list', () => {
  it('keeps the characters names are made of, and drops only Markdown’s marks', () => {
    expect(plainText("Found it: `export_rows` looks up each row's owner.")).toBe("Found it: export_rows looks up each row's owner.");
    expect(plainText('Edit `__init__.py`, then __init__.py and snake_case_name')).toBe('Edit __init__.py, then __init__.py and snake_case_name');
    expect(plainText('**Note:** keep *this* and _that_; a > b, 2 * 3 * 4 = 24')).toBe('Note: keep this and that; a > b, 2 * 3 * 4 = 24');
  });

  it('reads headings, quotes, tables, code and links as plain text', () => {
    const reply = '## Result\n\n> All green\n\n| test | ms |\n|---|:--:|\n| login | 42 |\n\n```ts\nrun();\n```\nSee [the log](https://ci.example/run_1).';
    expect(plainText(reply)).toBe('Result All green test ms login 42 run(); See the log.');
  });
});

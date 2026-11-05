import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = (name: string) => readFile(path.join('.github', 'workflows', name), 'utf8');

/** The text of one job: its line and every line indented under it. */
function job(text: string, name: string): string {
  const lines = text.split('\n');
  const at = lines.indexOf(`  ${name}:`);
  if (at < 0) throw new Error(`No job ${name}`);
  const end = lines.findIndex((line, i) => i > at && /^ {0,2}\S/.test(line));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

/** The `run: |` script of the step named `name`, as the runner gets it. */
function stepRun(text: string, name: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^\s*(- )?name: /.test(line) && line.slice(line.indexOf('name: ') + 6).trim() === name);
  if (at < 0) throw new Error(`No step named ${name}`);
  const key = lines[at]!.indexOf('name: ');
  const indent = (line: string) => line.length - line.trimStart().length;
  for (let i = at + 1; i < lines.length && !(lines[i]!.trim() && indent(lines[i]!) < key); i += 1) {
    if (indent(lines[i]!) !== key || !/^\s*run: \|\s*$/.test(lines[i]!)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !(lines[j]!.trim() && indent(lines[j]!) <= key); j += 1) body.push(lines[j]!);
    const pad = Math.min(...body.filter((line) => line.trim()).map(indent));
    return `${body.map((line) => line.slice(pad)).join('\n').trimEnd()}\n`;
  }
  throw new Error(`The step ${name} runs no script`);
}

describe('the package check in CI', () => {
  it('installs the package as people get it from npm, through a registry, never a tarball by its path', async () => {
    const text = job(await workflow('ci.yml'), 'package');
    const install = stepRun(text, 'Install the package as people get it, and serve the demo from it');
    expect(install.split('\n')[0]).toBe('node scripts/registry.mjs pelican-cc-*.tgz npm install -g pelican-cc --cache "$RUNNER_TEMP/npm-cache"');
    expect(text).not.toMatch(/npm (install|i) [^\n]*\.tgz/);
  });
});

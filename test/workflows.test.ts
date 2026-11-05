import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-workflows-'));
  await mkdir(path.join(dir, 'bin'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A command on PATH that logs how it was called and answers as `script` says. */
async function stub(name: string, script: string) {
  const file = path.join(dir, 'bin', name);
  await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${script}\n`);
  await chmod(file, 0o755);
}

/** Runs a step's script as the runner does (bash -e), in `dir`, with the stubs first on PATH. */
async function runStep(script: string, env: Record<string, string>) {
  const file = path.join(dir, 'step.sh');
  const calls = path.join(dir, 'calls');
  await writeFile(file, script);
  await writeFile(calls, '');
  const code = await new Promise<number>((resolve) => {
    execFile('bash', ['--noprofile', '--norc', '-e', file], {
      cwd: dir,
      env: { PATH: `${path.join(dir, 'bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: dir, CALLS: calls, ...env },
    }, (error) => resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0));
  });
  return { code, calls: (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean) };
}

describe('the release workflow', () => {
  let publish: string;
  beforeAll(async () => {
    publish = stepRun(await workflow('release.yml'), 'Publish with provenance (npm trusted publishing)');
    // npm as the registry answers: $PUBLISHED versions exist, dist-tags.latest is $LATEST ("fail": an error).
    await stub('npm', [
      'case "$*" in',
      '  "view pelican-cc@"*" version") [ "${2#pelican-cc@}" = "$PUBLISHED" ] && echo "$PUBLISHED" && exit 0; echo "npm error code E404" >&2; exit 1 ;;',
      '  "view pelican-cc dist-tags.latest") [ "$LATEST" = fail ] && { echo "npm error code ETIMEDOUT" >&2; exit 1; }; echo "$LATEST" ;;',
      '  publish*) ;;',
      '  *) echo "unexpected: npm $*" >&2; exit 1 ;;',
      'esac',
    ].join('\n'));
  });
  const release = async (tag: string, env: Record<string, string>) => {
    await writeFile(path.join(dir, `pelican-cc-${tag.slice(1)}.tgz`), '');
    try {
      const { code, calls } = await runStep(publish, { RELEASE_TAG: tag, PRERELEASE: 'false', PUBLISHED: '', ...env });
      return { code, published: calls.filter((call) => call.startsWith('npm publish')) };
    } finally {
      await rm(path.join(dir, `pelican-cc-${tag.slice(1)}.tgz`));
    }
  };

  it('publishes nothing when npm cannot say which version is latest', async () => {
    expect(await release('v0.2.4', { LATEST: 'fail' })).toMatchObject({ code: 1, published: [] });
    expect(await release('v0.3.1', { LATEST: '' })).toMatchObject({ code: 1, published: [] });
  });

  it('leaves latest to npm’s own check, and tags a fix for an older line and a release candidate', async () => {
    expect(await release('v0.3.1', { LATEST: '0.3.0' })).toEqual({ code: 0, published: ['npm publish ./pelican-cc-0.3.1.tgz --provenance --access public'] });
    expect(await release('v0.2.4', { LATEST: '0.3.0' })).toEqual({ code: 0, published: ['npm publish ./pelican-cc-0.2.4.tgz --provenance --access public --tag latest-0.2'] });
    expect(await release('v0.3.0-rc.2', { LATEST: '0.2.3', PRERELEASE: 'true' })).toEqual({
      code: 0, published: ['npm publish ./pelican-cc-0.3.0-rc.2.tgz --provenance --access public --tag next'],
    });
  });

  it('does not publish a version npm has already', async () => {
    expect(await release('v0.3.0', { LATEST: '0.3.0', PUBLISHED: '0.3.0' })).toEqual({ code: 0, published: [] });
  });
});

describe('the package check in CI', () => {
  it('installs the package as people get it from npm, through a registry, never a tarball by its path', async () => {
    const text = job(await workflow('ci.yml'), 'package');
    const install = stepRun(text, 'Install the package as people get it, and serve the demo from it');
    expect(install.split('\n')[0]).toBe('node scripts/registry.mjs pelican-cc-*.tgz npm install -g pelican-cc --cache "$RUNNER_TEMP/npm-cache"');
    expect(text).not.toMatch(/npm (install|i) [^\n]*\.tgz/);
  });
});

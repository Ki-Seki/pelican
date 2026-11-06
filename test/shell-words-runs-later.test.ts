// Quoted text that a shell runs later, by a road shell-words.ts does not follow, or follows only so
// far: each look-alike space in it is written out, as the approval card has you read the command.
// Against the shells too, where this computer has them: the space changes what runs (`p` logs).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { revealHidden } from '../src/shared/hidden';

const N = '\u00a0';
const bin = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pelican-runs-later-')));
writeFileSync(path.join(bin, 'w'), '#!/bin/sh\nprintf "[%s]" "$@"; printf "\\n"\n');
writeFileSync(path.join(bin, 'p'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PLOG"\n');
chmodSync(path.join(bin, 'w'), 0o755);
chmodSync(path.join(bin, 'p'), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const quoted = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** How Claude Code runs a Bash command, in zsh or bash (its snapshot expands aliases), in eval; and /bin/sh, as a hook runs. */
const SHELLS: Record<string, { file: string; args: (command: string) => string[] }> = {
  zsh: { file: '/bin/zsh', args: (command) => ['-c', `setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && eval ${quoted(command)}`] },
  bash: { file: '/bin/bash', args: (command) => ['-c', `shopt -s expand_aliases && eval ${quoted(command)} < /dev/null`] },
  sh: { file: '/bin/sh', args: (command) => ['-c', command] },
};
/** What `p` logged of the command, run in the shell. */
function logged(shell: string, command: string): string {
  const dir = mkdtempSync(path.join(bin, 'run-'));
  const log = path.join(dir, 'log');
  writeFileSync(log, '');
  const { file, args } = SHELLS[shell]!;
  spawnSync(file, args(command), { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PLOG: log, LC_ALL: 'C' }, timeout: 20_000 });
  return readFileSync(log, 'utf8');
}

/** What it is, the command (`N` for the space), and a shell where the space changes what runs. */
const CASES: Array<[string, string, string]> = [
  ["zsh's functions array", `functions[lint]='w lint${N}# fix later ; p PWNED'; lint`, 'zsh'],
  ["zsh's aliases array", `aliases[f]='w done${N}# ; p PWNED'; eval f`, 'zsh'],
  ["zsh's (e) flag", `x='$(w count${N}# ; p PWNED)'; w "\${(e)x}"`, 'zsh'],
  ["bash's @P", `x='$(w count${N}# ; p PWNED)'; w "\${x@P}"`, 'bash'],
  ['a subscript read evaluates', `x='a[$(w done${N}# ; p PWNED)]'; read -r "$x" </dev/null`, 'zsh'],
  ['a subscript printf -v evaluates', `x='a[$(w done${N}# ; p PWNED)]'; printf -v "$x" %s 1`, 'zsh'],
  ['arithmetic on a subscript', `n='a[$(w done${N}# ; p PWNED)]'; w $(( n + 1 ))`, 'sh'],
  ['PS4 under set -x', `PS4='$(w done${N}# ; p PWNED)'; set -x; :`, 'sh'],
];

describe('quoted text a shell runs later', () => {
  for (const [what, command, shell] of CASES) {
    it(`${what}: the card writes each such space out, and warns`, () => {
      expect(revealHidden(command, { runs: 'shell' })).toEqual({ text: command.replaceAll(N, '\u27e8U+00A0\u27e9'), hidden: true });
    });
    // bash has @P from 4.4: macOS's /bin/bash is 3.2.
    const missing = !existsSync(SHELLS[shell]!.file) || (command.includes('@P') && !/^(?:4\.[4-9]|[5-9])/.test(spawnSync(SHELLS[shell]!.file, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).stdout));
    it.skipIf(missing)(`${what}: the space changes what runs, in ${shell}`, () => {
      expect(logged(shell, command)).toContain('PWNED');
      expect(logged(shell, command.replaceAll(N, ' '))).not.toContain('PWNED');
    });
  }

  it('leaves such a space as it is in quoted text that holds no substitution’s start, or in a commit message', () => {
    for (const command of [`w 'a${N}b'`, `w "a${N}b \$(w c)"`, `git commit -m "$(cat <<'EOF'\nFix it${N}now, \$(and) \`this\`\nEOF\n)"`]) {
      expect(revealHidden(command, { runs: 'shell' }), command).toEqual({ text: command, hidden: false });
    }
  });
});

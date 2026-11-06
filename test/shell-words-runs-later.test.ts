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
  ksh: { file: '/bin/ksh', args: (command) => ['-c', command] },
  // A bash of 5.1 or later, as Linux has (macOS's /bin/bash is 3.2): Homebrew's, where it is.
  bash5: {
    file: ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'].find((file) => existsSync(file) && /^(?:5\.[1-9]|[6-9])/.test(spawnSync(file, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).stdout)) ?? '/nonexistent/bash',
    args: (command) => ['-c', `shopt -s expand_aliases && eval ${quoted(command)} < /dev/null`],
  },
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
  ["an escape of $'…' that makes the substitution's start", `n=$'a[\\x24(w done${N}# ; p PWNED)]'; w $(( n + 1 ))`, 'bash'],
  // An alias the command made, used as a command: what it stands for may run its arguments.
  ['an alias that stands for eval', `alias run=eval\nrun 'w done${N}# ; p PWNED'`, 'bash'],
  ['an alias for eval, used in eval', `alias run=eval; eval "run 'w done${N}# ; p PWNED'"`, 'zsh'],
  ['an alias that stands for trap', `alias later=trap\nlater 'w done${N}# ; p PWNED' EXIT`, 'sh'],
  ["zsh's global alias", `alias -g Y='| sh'; eval "echo 'w done${N}# ; p PWNED' Y"`, 'zsh'],
  // What a shell reads as it starts: a file the command writes and names, a function in its environment.
  ['a file BASH_ENV names', `echo 'w done${N}# ; p PWNED' > f.sh; BASH_ENV=./f.sh bash -c :`, 'zsh'],
  ['a .zshenv ZDOTDIR names', `echo 'w done${N}# ; p PWNED' > .zshenv; ZDOTDIR=. zsh -c :`, 'zsh'],
  ['a file ENV names', `echo 'w done${N}# ; p PWNED' > e.sh; env ENV=./e.sh sh -i -c : </dev/null`, 'sh'],
  ["bash's --rcfile", `echo 'w done${N}# ; p PWNED' > r.sh; bash --rcfile r.sh -i -c : </dev/null`, 'sh'],
  ['a function bash imports from the environment', `env 'BASH_FUNC_f%%=() { w done${N}# ; p PWNED; }' bash -c f`, 'sh'],
  // ksh93's `<<#` ends its heredoc at a line with blanks before its end: the line after it runs.
  ["ksh's <<# heredoc", `ksh -c 'cat <<#E\n  x\n  E\nw a${N}# ; p PWNED\n#E'`, 'ksh'],
  // What runs text later, or sets a variable whose name the text gives, however the text is made:
  // the substitution's start split across quotes, made by an expansion or an escape, or none at all.
  ['a split substitution a read evaluates', `x='a[$'"(w done${N}# ; p PWNED)]"; read -r "$x" </dev/null`, 'zsh'],
  ["a split substitution with $'' a read evaluates", `x='a[$'$''"(w done${N}# ; p PWNED)]"; read -r "$x" </dev/null`, 'sh'],
  ['a substitution made by an expansion', `d='$'; x="a[\${d}(w done${N}# ; p PWNED)]"; read -r "$x" </dev/null`, 'zsh'],
  ["a substitution made across $'…' strings", `x=$'a[$''(w done${N}# ; p PWNED)]'; read -r "$x" </dev/null`, 'sh'],
  ['arithmetic on a split substitution', `n='a[$'"(w done${N}# ; p PWNED)]"; w $(( n + 1 ))`, 'sh'],
  ['an arithmetic command', `n='a[$'"(w done${N}# ; p PWNED)]"; (( n ))`, 'bash'],
  ["[[ ]]'s -eq", `n='a[$'"(w done${N}# ; p PWNED)]"; [[ $n -eq 1 ]]`, 'bash'],
  ["[[ ]]'s -v", `x='a[$'"(w done${N}# ; p PWNED)]"; [[ -v $x ]]`, 'bash5'],
  ['a nameref', `declare -n r='a[$'"(w done${N}# ; p PWNED)]"; w $r`, 'bash5'],
  ['an indirect expansion', `x='a[$'"(w done${N}# ; p PWNED)]"; a=(1); w \${!x}`, 'bash'],
  ['a subscript', `x='a[$'"(w done${N}# ; p PWNED)]"; a=(1); w \${a[x]}`, 'bash'],
  ['an offset', `x='a[$'"(w done${N}# ; p PWNED)]"; y=abc; w \${y:x}`, 'bash'],
  ["an array's element by its subscript", `x='a[$'"(w done${N}# ; p PWNED)]"; a=(1 [x]=2)`, 'bash'],
  ['let', `let 'a[$'"(w done${N}# ; p PWNED)]"`, 'bash'],
  ['unset', `a=(1); unset 'a[$'"(w done${N}# ; p PWNED)]"`, 'zsh'],
  ["zsh's export", `export 'a[$'"(w done${N}# ; p PWNED)]=1"`, 'zsh'],
  ["ksh's printf", `ksh <<'E'\nprintf '%d' 'a[$'"(w done${N}# ; p PWNED)]"\nE`, 'sh'],
  ["ksh's test", `ksh <<'E'\ntest 'a[$'"(w done${N}# ; p PWNED)]" -eq 1\nE`, 'sh'],
  ["zsh's set -A of functions", `set -A functions lint 'w lint${N}# fix later ; p PWNED'; lint`, 'zsh'],
  ["zsh's read of functions", `read -r 'functions[lint]' <<< 'w lint${N}# fix later ; p PWNED'; lint`, 'zsh'],
  ["zsh's typeset of functions", `typeset 'functions[lint]=w lint${N}# fix later ; p PWNED'; lint`, 'zsh'],
  ["zsh's := of functions", `: \${functions[lint]:='w lint${N}# fix later ; p PWNED'}; lint`, 'zsh'],
  ["zsh's autoload of a file the command writes", `echo 'w a${N}# ; p PWNED' > f; fpath=(.); autoload f; f`, 'zsh'],
  ['an alias made after command', `command alias run=eval\nrun 'w lint${N}# ; p PWNED'`, 'bash'],
  ['an alias made after builtin', `builtin alias run=eval\nrun 'w lint${N}# ; p PWNED'`, 'sh'],
  ['an alias made by a variable', `a=alias; $a run=eval\nrun 'w lint${N}# ; p PWNED'`, 'sh'],
  ["bash's array of aliases", `BASH_ALIASES[run]=eval\nrun 'w done${N}# ; p PWNED'`, 'bash5'],
  ['eval after builtin', `builtin eval 'w done${N}# ; p PWNED'`, 'zsh'],
  ["eval after zsh's exec", `exec eval 'w done${N}# ; p PWNED'`, 'zsh'],
  ['eval after time -p', `time -p eval 'w done${N}# ; p PWNED' 2>/dev/null`, 'bash'],
  ['eval as the arguments a command sets', `set -- eval 'w done${N}# ; p PWNED'; "$@"`, 'sh'],
  ['eval as the last word of the command before', `: eval; $_ 'w done${N}# ; p PWNED'`, 'zsh'],
  ["compgen's -C", `compgen -C 'w done${N}# ; p PWNED' x`, 'bash'],
  ["mapfile's callback", `mapfile -C 'w done${N}# ; p PWNED' -c 1 < <(echo x)`, 'bash5'],
  ['a prompt in the environment of a shell it starts', `env PS4='$'"(w done${N}# ; p PWNED)" bash -xc : 2>/dev/null`, 'sh'],
  ['a file it writes, found on the PATH it sets', `echo 'w a${N}# ; p PWNED' > lz; chmod +x lz; PATH=.:$PATH lz`, 'sh'],
  ['a function whose body sets a variable the text names', `x='a[$'"(w done${N}# ; p PWNED)]"; f() { local "$x=1"; }; f`, 'bash'],
  // Arithmetic reads a variable the command sets to what is not a number, however it sets it.
  ['a loop variable that is not always a number', `abc='a[$'"(w done${N}# ; p PWNED)]"; for i in 1 abc; do w $((i)); done`, 'bash'],
  ["the last word of the command before, `$_`", `: 'a[$'"(w done${N}# ; p PWNED)]"; w $(( _ ))`, 'bash'],
  ['a variable set in the environment of a shell it starts', `x='a[$'"(w done${N}# ; p PWNED)]"; env n="$x" bash -c 'w $((n))'`, 'zsh'],
  ["a variable bash reads as arithmetic, OPTIND", `x='a[$'"(w done${N}# ; p PWNED)]"; OPTIND=x`, 'bash'],
  ["a variable set by ${n:=…}", `: \${n:='a[$'"(w done${N}# ; p PWNED)]"}; w $((n))`, 'bash'],
  ['a file it makes a program, found on the PATH it sets', `printf 'w a${N}# ; p PWNED\\n' > t; chmod +x t; PATH=.:$PATH t`, 'zsh'],
  // A script run by a path that is not plain text: the file it names may be one the command wrote.
  ['a script in a file a variable names', `t=$(mktemp ./t.XXXXXX); cat > "$t" <<'EOF'\nw done${N}# ; p PWNED\nEOF\nbash "$t"`, 'zsh'],
  ['a script in a folder a variable names', `d=$(mktemp -d ./d.XXXXXX); cat > "$d/fix.sh" <<'EOF'\nw done${N}# ; p PWNED\nEOF\nsh "$d/fix.sh"`, 'sh'],
  ['a program run by a path a variable makes', `d=.; printf 'w done${N}# ; p PWNED\\n' > lz; chmod +x lz; "$d/lz"`, 'zsh'],
  // What the command writes some other way, then runs from where it landed.
  ['a script dd writes', `dd of=f status=none <<< 'w lint${N}# ; p PWNED'; sh f`, 'sh'],
  ['a script it writes from another descriptor', `sh -c "echo 'w done${N}# ; p PWNED' >&2" 2> f.sh; sh f.sh`, 'sh'],
  ['a program unpacked, run from where it landed', `printf '#!/bin/sh\\nw done${N}# ; p PWNED\\n' > x.sh; chmod +x x.sh; tar cf a.tar x.sh; rm x.sh; mkdir u; tar xf a.tar -C u; u/x.sh`, 'sh'],
  ['a git hook it writes', `git init -q . && cat > .git/hooks/pre-commit <<'EOF'\n#!/bin/sh\nw done${N}# ; p PWNED\nEOF\nchmod +x .git/hooks/pre-commit && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x`, 'sh'],
  // A name in any case: macOS's file system takes READ for /usr/bin/read, which runs `builtin read`.
  ['read named in capitals', `x='a[$'"(w done${N}# ; p PWNED)]"; READ -r "$x" < /dev/null`, 'zsh'],
  ['read named in capitals, by its path', `x='a[$'"(w done${N}# ; p PWNED)]"; /usr/bin/READ -r "$x" < /dev/null`, 'sh'],
  ['read named in capitals, run by env', `env READ -r 'a[$'"(w done${N}# ; p PWNED)]" < /dev/null`, 'sh'],
  // zsh's patterns from a variable's value, whose qualifiers run what they say.
  ["zsh's $~", `setopt extendedglob; x='/(#qe{w lint${N}# ; p PWNED})'; w $~x >/dev/null`, 'zsh'],
  ["zsh's \${~x}", `setopt extendedglob; x='/(#qe{w lint${N}# ; p PWNED})'; w \${~x} >/dev/null`, 'zsh'],
  ["zsh's globsubst, as zsh -o sets it", `zsh -o globsubst -o extendedglob -c "x='/(#qe{w lint${N}# ; p PWNED})'; w \\$x >/dev/null"`, 'sh'],
  // test and [ take their operator as the words come: a variable can give -v.
  ['test with an operator a variable gives', `op=-v; x='a[$'"(w done${N}# ; p PWNED)]"; test "$op" "$x"`, 'bash5'],
  ['[ with an operator a variable gives', `op=-v; x='a[$'"(w done${N}# ; p PWNED)]"; [ "$op" "$x" ]`, 'bash5'],
  ['test with an operator a default gives', `x='a[$'"(w done${N}# ; p PWNED)]"; test "\${op:--v}" "$x"`, 'bash5'],
];

describe('quoted text a shell runs later', () => {
  for (const [what, command, shell] of CASES) {
    it(`${what}: the card writes each such space out, and warns`, () => {
      expect(revealHidden(command, { runs: 'shell' })).toEqual({ text: command.replaceAll(N, '\u27e8U+00A0\u27e9'), hidden: true });
    });
    // bash has @P from 4.4: macOS's /bin/bash is 3.2. ksh may not be there. READ is read only where
    // the file system takes no notice of case, as macOS's does.
    const missing = !existsSync(SHELLS[shell]!.file) || (command.includes('@P') && !/^(?:4\.[4-9]|[5-9])/.test(spawnSync(SHELLS[shell]!.file, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).stdout))
      || (command.includes('READ') && !existsSync('/usr/bin/READ'));
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

  it('leaves it as it is beside what runs no text: numbers in arithmetic, a string printf writes, a test of strings', () => {
    for (const command of [
      `w $(( 1 + 2 )) 'a${N}b'`, `w $(( 16#ff + 0x1f )) 'a${N}b'`, `w "\${#x}" 'a${N}b'`, `w "\${x:0:2}" 'a${N}b'`, `w "\${a[@]}" 'a${N}b'`,
      `printf '%s\n' 'a${N}b'`, `[ "$x" = 'a${N}b' ] && w y`, `[[ $x == 'a${N}b' ]] && w y`, `[ $# -eq 0 ] && w 'a${N}b'`,
      `command -v git && git commit -m 'a${N}b'`, `X=1 w 'a${N}b'`, `cd /tmp && w 'a${N}b'`, `hash -r; w 'a${N}b'`,
      `n=0; for d in */; do n=$((n+1)); done; w "$n" 'a${N}b'`, `for i in 1 2 3; do w $((i*2)) 'a${N}b'; done`,
      `[[ $n -gt 2 ]] && w 'a${N}b'`, `export PATH="$HOME/bin:$PATH" LANG=C; w 'a${N}b'`, `f() { local x=1; w "$x" 'a${N}b'; }; f`,
      `K='timeout 9 kubectl'; $K get pods; w 'a${N}b'`, `echo hi > out.txt; PATH=/opt/bin:$PATH w 'a${N}b'`, `grep -r read src; w 'a${N}b'`,
      // Beside what is now not followed: a script it writes and runs by its name, a write to a
      // variable's file, a commit before running a script, test and [ with their operators as text.
      `cat > fix.sh <<'EOF'\nw 'a${N}b'\nEOF\nbash fix.sh`, `T=$(mktemp); w 'a${N}b' > "$T"; cat "$T"`, `git commit -qm x && ./deploy.sh 'a${N}b'`,
      `[ -f "$x" ] && w 'a${N}b'`, `[ "$a" = "$b" ] || test -n "$c" && w 'a${N}b'`, `set -euo pipefail; READ_ME=1 w 'a${N}b'`,
      `cp ~/Desktop/'Shot 1${N}AM.png' docs/ && open docs/'Shot 1${N}AM.png'`, `sed -i '' 's/a/b/' x.txt && w 'a${N}b'`,
    ]) {
      expect(revealHidden(command, { runs: 'shell' }), command).toEqual({ text: command, hidden: false });
    }
  });
});

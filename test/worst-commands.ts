// Commands made to cost the most to read for their look-alike spaces, each about `size` characters
// with one look-alike space (U+00A0): those that made a script of the square of their size, and
// those that are read again and again, or look ahead, or make the most of each step. For
// test/shell-words-budget.test.ts, in Node and in a browser.

const N = '\u00a0';

/** `head`, `unit` as many times as fit in `size`, `tail`. */
const fill = (unit: string, size: number, head = `echo 'a${N}b'; `, tail = '') => head + unit.repeat(Math.max(1, Math.floor((size - head.length - tail.length) / unit.length))) + tail;

/** Heredocs fed to bash within one another, `depth` deep, around `body`. */
const fed = (body: (room: number) => string, size: number, depth = 60) => {
  const head = `echo 'a${N}b'\n${Array.from({ length: depth }, (_, i) => `bash <<'E${i}'\n`).join('')}`;
  const tail = Array.from({ length: depth }, (_, i) => `E${depth - 1 - i}\n`).join('');
  return `${head}${body(size - head.length - tail.length - 1)}\n${tail}`;
};

export const WORST: Record<string, (size: number) => string> = {
  // A long value in many places of a script handed to a shell (the recheck's): a script of the square of the command's size.
  'a value in many places of a script bash runs': (size) => {
    const value = 'a'.repeat(Math.floor(size * 0.6));
    return `x=${value}; echo 'a${N}b'; bash -c "${'$x '.repeat(Math.floor((size - value.length - 30) / 3))}"`;
  },
  'a value in many places of what echo feeds sh': (size) => {
    const value = 'a'.repeat(Math.floor(size * 0.6));
    return `x=${value}; echo 'a${N}b'; echo ${'$x '.repeat(Math.floor((size - value.length - 30) / 3))}| sh`;
  },
  'a short value in very many places': (size) => fill('$x', size - 60, `x=${'a'.repeat(40)}; echo 'a${N}b'; bash -c "`, '"'),
  'heredocs fed to bash within one another': (size) => fed((room) => fill('${x:-y} ', room, ''), size),
  'scripts handed to bash within one another': (size) => `echo 'a${N}b'; ${'bash -c "'.repeat(60)}${'x'.repeat(Math.max(1, size - 700))}${'"'.repeat(60)}`,
  'substitutions within substitutions': (size) => fill('$(echo $(a)) ', size, `echo 'a${N}b' `),
  'substitutions': (size) => fill('$(a)', size, `echo 'a${N}b' `),
  'backquotes': (size) => fill('`a`', size, `echo 'a${N}b' `),
  'process substitutions': (size) => fill('<(a) ', size, `echo 'a${N}b' `),
  'parameter expansions within one another': (size) => `echo 'a${N}b' ${'${x:-'.repeat(40)}${'y'.repeat(Math.max(1, size - 400))}${'}'.repeat(40)}`,
  'an unquoted heredoc of substitutions': (size) => `cat <<E\n${fill('$(a)', size - 40, '')}\nE\necho 'a${N}b'`,
  'quotes of every kind': (size) => fill(`"x" 'y' $'z' \\w `, size, `echo 'a${N}b' `),
  'a script written again and again, then run': (size) => fill("echo 'w ok' > f.sh; ", size, `echo 'a${N}b'; `, 'bash f.sh'),
  'what su or flock runs, looked for after each': (size) => fill('flock ', size),
  'what env -S splits, looked for after each': (size) => fill('env ', size),
  "ssh's arguments to a shell that reads its input": (size) => `echo 'a${N}b'; ssh h bash -s ${'a '.repeat(Math.floor((size - 40) / 2))}`,
  'a run of reserved words, then of (': (size) => `echo 'a${N}b'; ${'if '.repeat(Math.floor((size - 20) / 6))}${'( '.repeat(Math.floor((size - 20) / 4))}`,
  "printf's zeros": (size) => `echo 'a${N}b'; printf '%${'0'.repeat(size - 40)}d' 1`,
  'a word of S after env, and a line break': (size) => `echo 'a${N}b'; env "-${'S'.repeat(size - 40)}\n"`,
  'arithmetic on many variables': (size) => `echo 'a${N}b'; echo $(( ${'a+'.repeat(Math.floor((size - 40) / 2))}1 ))`,
  'tests of what variables hold': (size) => fill('[ -f "$x" ] && ', size, `echo 'a${N}b'; `, 'true'),
  'writes into a folder, then a run from it': (size) => fill('echo x > a/b; ', size, `echo 'a${N}b'; `, './a/c'),
  'functions': (size) => fill('f() { :; }; ', size),
  'cases': (size) => fill('case x in a) b;; esac; ', size),
};

/** The costliest of them to read, by what they took in Node and in Chrome with its CPU slowed four times. */
export const COSTLIEST = [
  'a value in many places of a script bash runs',
  'a short value in very many places',
  'heredocs fed to bash within one another',
  'substitutions within substitutions',
  'backquotes',
  'process substitutions',
  'parameter expansions within one another',
  'an unquoted heredoc of substitutions',
  "ssh's arguments to a shell that reads its input",
  'a script written again and again, then run',
];

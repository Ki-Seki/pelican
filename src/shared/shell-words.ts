/**
 * Where a shell reads a command's characters as part of a word, so that a space other than a plain
 * one there joins what shows as two words (src/shared/hidden.ts). Every such character counts as in
 * a word but where this finds it, for sure, quoted (in single or double quotes, in `$'…'`, after a
 * backslash), in the body of a heredoc or in a comment, as each shell below reads the command: then
 * it is text.
 *
 * It reads the command as bash 5.2 and later, zsh and dash do, and as bash 3.2 (macOS's `/bin/bash`
 * and `/bin/sh`, which run hooks there) does too, which finds where a `$( )` ends by its own rules
 * (bash32End) and so may run what the others take for a heredoc's body or a comment; a character
 * in a word for either counts. Inside `$( )`, `<( )`, `>( )`, backquotes, `$(( ))`, `${ }`, a
 * subshell, a case, a function and an array too. It follows a script the command hands to a new
 * shell: the one after `-c` of sh, bash, zsh, dash, ksh and the like (also where sudo, env, find
 * -exec or another program runs them), of su, flock or script, the command ssh or watch runs, and
 * what a heredoc, a here-string, `echo` or `cat` feeds a shell that reads its commands from its
 * input (`bash <<EOF`, `echo … | sh`, `ssh host 'bash -s' <<EOF`), and a file the command writes
 * with them and then runs or reads as a script (`cat > fix.sh <<'EOF' … EOF`, then `bash fix.sh`,
 * `./fix.sh`, `sh < fix.sh`, or by its name alone where the command sets PATH and makes it a
 * program; found by the last part of its name). In such a script a variable the command sets to
 * plain text stands for that text, and one it does not set, the user's own, for a word of its own.
 * Quoted text with a substitution's start in it (`$(`, `${`, a backquote) counts as in a word too.
 *
 * What runs text later, in the shell that reads the command, is not followed, however the text is
 * made (split across quotes, by an expansion, by an escape): a command that uses it counts as one
 * this cannot tell. That is a builtin that runs text or sets a variable whose name the text gives,
 * where a subscript runs (RUNS_LATER: eval, source and `.`, trap, alias, read, mapfile, getopts,
 * let, unset, declare and typeset, zsh's autoload, emulate, zpty and the like), also after
 * `command`, `builtin`, zsh's `exec` and `noglob`, or run by env, sudo or xargs as macOS's
 * /usr/bin/read runs `builtin read`; export, local and readonly with an option or a name that is
 * not plain; printf -v, print -P and -v, set -A, wait -p, hash -p, `[[ ]]`'s -v and -R; a command
 * whose name this does not know, which may be any of them; a variable whose value a shell runs or
 * reads as arithmetic (zsh's functions, aliases, commands and options arrays, bash's BASH_ALIASES and
 * BASH_CMDS, a prompt such as PS4, OPTIND and RANDOM set to what is not a number); zsh's parameter
 * flags such as (e), (P) and (%), bash's @P and `${!x}`; and arithmetic (`$(( ))`, a subscript, an
 * offset, the sides of `[[ ]]`'s -eq, and in a script ksh runs those of `test`, printf, shift and
 * ulimit) that reads a variable the command sets to what is not a number, an argument, `$_` or what
 * a substitution writes: arithmetic reads a variable's value as an expression, and a subscript in it
 * (`a[$(…)]`) runs.
 *
 * Where it cannot tell, every such character counts as in a word (inWords gives undefined): what
 * runs text later, above; a syntax error (a quote never closed, a heredoc whose line never comes, a
 * `)` that closes nothing), which may be one only here; what the shells read otherwise (`<<(`, a `(`
 * where an argument would be, a `{` inside `${ }`, `${ cmd; }`, `$'…\'…'`, quotes inside `$(( ))`,
 * `$[ ]`); a script handed to a shell with text in it this does not know (a substitution, an
 * argument such as `$1`, a variable set to what this does not know, braces or a pattern; what
 * printf, xargs or a filter make); text of the command that may reach a shell's input any other way
 * (through a loop, a function, `exec`, a subshell or a coprocess); a file the command writes and
 * runs as a script with what this does not know in it (from printf, an unquoted heredoc that
 * expands, or added to); and what is nested deeper than it reads.
 * Past what bash 3.2 takes for a `$( )` never closed it runs nothing more of that command, so only
 * the others are read there: a commit message in `"$(cat <<'EOF' … EOF)"` with an odd apostrophe is
 * such a one.
 *
 * Not followed: what a program runs in a shell of its own beyond those above (python -c with
 * os.system, node -e, make, git aliases, tmux), a script in a file the command does not write that
 * way (one it copies or edits, or that was there), the output of a `$( )` or a variable, which the
 * shell splits into words but does not read as a command, and where bash 4.0 to 5.1 end a `$( )`
 * (by rules of their own, not checked here).
 */

/** What an expansion stands for, unknown here. */
type Made = 'parameter' | 'command' | 'process' | 'arithmetic' | 'escape';

/** A character of a script, and where it is in the text shown (-1: nowhere, as one an escape stands for); for `${name}`, its name. */
type Piece = { char: string; at: number; made?: Made; name?: string };

/** A word of a simple command, as the shell has it once quotes are gone. */
type Word = {
  text: string;
  pieces: Piece[];
  /** Neither quoted, escaped nor expanded: a reserved word, where it is one. */
  plain: boolean;
  /** Holds an expansion, whose text is not known here. */
  made: boolean;
  /** Holds unquoted braces or a pattern (`*`, `?`, `[…]`, `{…}`): they may make other words of it. */
  open: boolean;
  /** Its unquoted `{`, `}`, `[`, `]`, `*`, `?`, `,` and `.`, in order. */
  specials: string;
  /** Names a function the command defines, whose body's first command follows it among the words (`f() { …`). */
  defines?: boolean;
};

/** What a command reads at its input from the command line: a heredoc's body, a here-string. Not `exact`: what the shell makes of it is not known here. */
type Input = { pieces: Piece[]; exact: boolean };

/**
 * A simple command, as far as what reaches a shell goes: `echo` or `cat` pass on what they are
 * given, `shell` reads its commands from its input, `runs` runs what it is handed with this input
 * (eval, source, a shell's `-c`, ssh, `exec` alone, a command whose name is not known), `program`
 * runs nothing it reads, as far as this follows.
 */
type Command = {
  words: Word[];
  kind: 'program' | 'echo' | 'cat' | 'shell' | 'runs';
  /** What `echo` writes, or undefined where it is not known here. */
  echoes?: Piece[];
  inputs: Input[];
  /** Its input is a file, and which, by the last part of its name, where known. */
  fromFile: boolean;
  from?: string;
  /** Ends a compound command (`)`, `}`, `done`, `fi`, `esac`), or begins one where it is fed. */
  compound: boolean;
  /** Begins a compound command: a loop or a branch, fed when it is not first in its pipeline. */
  opens: boolean;
  /** Holds a command substitution, which reads the input of the command it is in. */
  substitutes: boolean;
  /** The files its output goes to, by the last part of their names (where known), and whether it adds to them. */
  writes: Array<{ file?: string; append: boolean }>;
};

/** A heredoc that waits for its body: the line that ends it, whether tabs before its lines go, whether its body is as it is, and where it goes. */
type Heredoc = { end: string; tabs: boolean; quoted: boolean; input: Input };

/** How `$( )` is read: as bash 5, zsh and dash read it, or as bash 3.2 does (bash32End). */
type Dialect = 'modern' | 'bash32';

/** What this does not follow, a syntax error, or what shells read differently: every such character counts. */
class Lost extends Error {}

/** bash 3.2 finds no end to a `$(`: a syntax error to it, so it runs nothing of the command from there. */
class Unclosed extends Error {}

/** Shells that take a script after `-c`, or read one from their input. `$SHELL` is the user's. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'csh', 'tcsh', '$SHELL', '$BASH', '${SHELL}', '${BASH}']);

/** Reserved words after which a command's name may still come. */
const BEFORE_COMMAND = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time']);

/** Reserved words that begin a compound command where they come first, and those that end one. */
const OPENS = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{']);
const CLOSES = new Set(['}', 'fi', 'done', 'esac']);

/**
 * Variables whose value a shell runs, or that change what a name runs or how text reads: zsh's
 * arrays of functions, aliases, commands and options (`functions[lint]=…` defines one), bash's of
 * aliases and commands (`BASH_ALIASES[run]=eval`), and the prompts bash and zsh expand, PS4 among
 * them.
 */
const CODE_VARIABLES = /^(?:(?:dis_)?(?:functions|aliases|galiases|saliases)(?:_source)?|commands|options|BASH_ALIASES|BASH_CMDS|PS[0-4]|PROMPT[0-4]?|RPROMPT2?|RPS[12]|SPROMPT|PROMPT_COMMAND)$/;

/**
 * Builtins that run text, now or later, or set a variable whose name the text gives (a subscript in
 * that name runs, as zsh's functions[…] defines one): bash's, zsh's, ksh's and dash's. A command
 * that uses one is not followed: every look-alike space in it counts as in a word. So too for the
 * forms of others that do (runsLater).
 */
const RUNS_LATER = new Set([
  'eval', 'source', '.', 'trap', 'alias', 'autoload', 'emulate', 'functions', 'zpty', 'sched', 'zle', 'bindkey', 'zstyle',
  'zmodload', 'compgen', 'complete', 'compctl', 'bind', 'fc', 'enable', 'read', 'mapfile', 'readarray', 'getopts', 'let',
  'unset', 'declare', 'typeset', 'integer', 'float', 'private', 'nameref', 'vared', 'zparseopts', 'zformat', 'strftime',
  'zstat', 'sysread', 'zsocket', 'ztcp', 'zselect', 'pcre_match', 'zregexparse', 'getln',
]);

/**
 * Builtins that set variables by name, which run text only where that name is not a plain one (zsh's
 * `export 'a[$(…)]=1'`, bash's `local`) or an option gives them a kind that reads it: otherwise what
 * they do is an assignment, and is read as one (assigns).
 */
const DECLARING = new Set(['export', 'local', 'readonly']);

/**
 * Builtins macOS also has as programs (/usr/bin/read runs `builtin read` in sh), so a program that
 * runs its arguments as a command (env, sudo, nohup, xargs, find -exec) runs them too: `env read
 * 'a[$(…)]'` runs the substitution, `env command eval '…'` the text.
 */
const WRAPPED = new Set(['read', 'command', 'getopts', 'jobs', 'wait', 'fc', 'hash', 'alias', 'eval']);

/** Programs that run their arguments as a command. */
const EXEC_RUNNERS = new Set(['env', 'sudo', 'doas', 'nohup', 'timeout', 'gtimeout', 'nice', 'renice', 'setsid', 'stdbuf', 'xargs', 'parallel', 'flock', 'chronic', 'caffeinate', 'unbuffer', 'time', 'ionice', 'chrt', 'taskset', 'numactl', 'strace', 'ltrace', 'valgrind', 'arch', 'xcrun', 'script', 'watch', 'find', 'busybox', 'command', 'builtin', 'exec']);

/**
 * Variables a shell reads a value of as arithmetic, which runs a subscript's substitution: bash's
 * OPTIND, HISTCMD and RANDOM, ksh's SECONDS, LINENO and the like. Set to anything but a number,
 * the command is not followed.
 */
const NUMERIC_VARIABLES = /^(?:OPTIND|OPTERR|HISTCMD|RANDOM|SRANDOM|SECONDS|EPOCHSECONDS|EPOCHREALTIME|LINENO|SHLVL|TMOUT|MAILCHECK|PPID|UID|EUID|GID|EGID|BASHPID|HISTSIZE|HISTFILESIZE|SAVEHIST|COLUMNS|LINES|KEYTIMEOUT|PERIOD|LISTMAX|DIRSTACKSIZE|FUNCNEST|BASH_XTRACEFD|LOGCHECK|REPORTTIME|REPORTMEMORY|TRY_BLOCK_ERROR|TRY_BLOCK_INTERRUPT|ZLE_RPROMPT_INDENT|ERRNO)$/;

/** What a shell runs the command after as it is, a builtin too (zsh's `exec eval` and `noglob eval` among them): their names. */
const MODIFIERS = new Set(['command', 'builtin', 'exec', 'noglob', 'nocorrect', '-', 'time', 'coproc', 'jobs']);

/** The operators by which `[[ ]]`, and ksh's `test`, read their sides as arithmetic. */
const NUMERIC_TEST = /^-(?:eq|ne|lt|le|gt|ge)$/;


/**
 * Text arithmetic reads (a subscript, an offset): whether it holds only numbers, operators and
 * variables, by name or as `$name` or `${name}`, which `count` takes (their values are judged once
 * the whole command is read); a substitution, an argument (`$1`) or quotes in it are not followed.
 */
function arithmeticOf(text: string, count: (name: string) => void): boolean {
  const rest = text.replace(/\$\{#[A-Za-z_][A-Za-z0-9_]*\}|\$[?#$!]/g, '0').replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|(?<![0-9A-Za-z_#])([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced: string | undefined, bare: string | undefined) => {
    count((braced ?? bare)!);
    return '0';
  });
  return /^[\s0-9A-Za-z_#()+\-*\/%<>=!&|^~?:,.[\]]*$/.test(rest) && !rest.includes('$');
}

/** What bash, zsh, ksh, sh and csh read as they start, by name. */
const STARTUP_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout', '.kshrc', '.mkshrc', '.shrc', '.cshrc', '.tcshrc', '.login'];

/** Commands whose `name=(…)` is an array. */
const DECLARES = new Set(['declare', 'typeset', 'local', 'readonly', 'export', 'integer', 'float']);

/** A word that assigns, after which the command's name may still come; and one that opens an array, `name=(`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const ARRAY = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;

/**
 * Whether a word's unquoted `{`, `}`, `[`, `]`, `*`, `?`, `,` and `.` make a pattern or braces that
 * may make other words of it: a `*` or a `?`, a `[` with a `]` after it, or a `{` with a `,` or `..`
 * after it before the `}` that ends it, no other brace between. Read once, left to right: as a
 * pattern of backtracking, a word of 160,000 `[` took seconds.
 */
function opens(specials: string): boolean {
  if (specials.includes('*') || specials.includes('?')) return true;
  const bracket = specials.indexOf('[');
  if (bracket >= 0 && specials.lastIndexOf(']') > bracket) return true;
  let brace = false;
  let separated = false;
  for (let i = 0; i < specials.length; i += 1) {
    const c = specials[i];
    if (c === '{') {
      brace = true;
      separated = false;
    } else if (c === '}') {
      if (brace && separated) return true;
      brace = false;
    } else if (brace && (c === ',' || (c === '.' && specials[i + 1] === '.'))) {
      separated = true;
    }
  }
  return false;
}

/** What `$'…'` makes of an escape that stands for one character this knows. */
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** What follows a `$` in zsh's `$=x`, `$~x`, `$^x` and `$+x`: an expansion too. */
const PARAMETER = /^[=~^+]$/;

/** Text a variable may stand for in a script handed on with no change to its quotes or commands. */
const PLAIN = /^[A-Za-z0-9_.\/:@%+=,~ \t-]*$/;

/** Programs that run what they are given, or what follows them, so a variable that names one is not known. */
const RUNNERS = new Set([...RUNS_LATER, ...MODIFIERS, ...DECLARING, ...WRAPPED, 'su', 'sudo', 'doas', 'ssh', 'watch', 'xargs', 'parallel', 'flock', 'script', 'env', 'nohup', 'timeout', 'nice', 'setsid', 'stdbuf']);

/** A stand-in for what an expansion gives, unknown here: part of a word, and nothing to show. */
const expansion = (made: Made): Piece => ({ char: '\u0000', at: -1, made });
const SPACE: Piece = { char: ' ', at: -1 };
const NEWLINE: Piece = { char: '\n', at: -1 };

const blank = (char: string | undefined) => char === ' ' || char === '\t';
const breaks = (char: string | undefined) => char === undefined || ' \t\n;&|<>()'.includes(char);
const textOf = (pieces: readonly Piece[]) => pieces.map((piece) => piece.char).join('');
const program = (word: Word) => word.text.split('/').pop()!;

/** At most this deep in `$( )`, quotes, `${ }` and the like; deeper, every such character counts. */
const MOST_DEPTH = 48;

/** At most this many scripts in one command, those it hands to a shell included; past them, every such character counts. */
const MOST_SCRIPTS = 64;

/** What the readings of one command share. */
type Shared = {
  asked: (char: string) => boolean;
  found: Set<number>;
  /** The scripts to read: the command, then what it hands to a shell. */
  scripts: Piece[][];
  /** The pipelines of the script being read, judged once all of it is (their heredocs too). */
  pipelines: Command[][];
  dialect: Dialect;
  depth: number;
  /** What all readings found, across scripts and dialects. */
  across: Across;
};

/** What decides, once every script is read, whether a shell may read what this does not follow. */
type Across = {
  /** A shell somewhere reads its commands from its input. */
  readsInput: boolean;
  /** Something that may run a shell is fed from the command line otherwise than this follows: lost if a shell reads its input. */
  risky: boolean;
  /** Names given to a function, and the names of commands that are fed. */
  functions: Set<string>;
  fed: Set<string>;
  /** The command sets where a shell finds a program by its name (PATH): a file it writes and makes a program may run. */
  path: boolean;
  /** The files the command makes programs (chmod +x, install, cp and the like), by the last part of their names. */
  executables: Set<string>;
  /** Variables arithmetic reads: their values, as the command sets them, must be numbers. */
  counted: Set<string>;
  /** A ksh runs a script: its `<<#` heredoc, which strips the blanks before its lines, this does not read. */
  ksh: boolean;
  /** What the command sets a variable to: its text, or null where it is not known here. */
  values: Map<string, string | null>;
  /** The files the command writes, by the last part of their names: what goes in (as each reading has it), or null where it is not known here. */
  files: Map<string, Input[] | null>;
  /** The files the command runs as a script, by the last part of their names: read once it is known what goes in them. */
  runs: Set<string>;
};

type Case = { kind: 'case'; stage: 'subject' | 'in' | 'pattern' | 'arm'; patterns: number };
type Frame = { kind: 'subshell' } | { kind: 'array' } | Case;

const newCommand = (): Command => ({ words: [], kind: 'program', inputs: [], fromFile: false, compound: false, opens: false, substitutes: false, writes: [] });

class Reader {
  private i = 0;

  /** Reading the body of an unquoted heredoc, which bash 3.2 expands only when it runs. */
  private heredoc = false;

  /**
   * @param p the script
   * @param shared what the readings of the command share
   * @param cut the text bash 3.2 takes for a `$( )`: it may end in a heredoc's body, which then ends with it
   */
  constructor(private readonly p: readonly Piece[], private readonly shared: Shared, private readonly cut = false) {}

  /** A whole script. Past a `$(` bash 3.2 never closes, it runs nothing more of it. */
  script(): void {
    this.nest(() => {
      try {
        this.code(false);
      } catch (error) {
        if (!(error instanceof Unclosed)) throw error;
      }
    });
  }

  /** Text that is no script but runs what is in `$( )`, `${ }` or backquotes: an unquoted heredoc's body. */
  heredocBody(): void {
    this.heredoc = true;
    this.nest(() => {
      try {
        this.expansions();
      } catch (error) {
        if (!(error instanceof Unclosed)) throw error;
      }
    });
  }

  /** One level deeper; too deep, and every such character counts. */
  private nest<T>(read: () => T): T {
    this.shared.depth += 1;
    try {
      if (this.shared.depth > MOST_DEPTH) throw new Lost();
      return read();
    } finally {
      this.shared.depth -= 1;
    }
  }

  /** A character the shell reads in a word: found, if it is one asked about. */
  private flag(piece: Piece | undefined): void {
    if (piece && piece.at >= 0 && this.shared.asked(piece.char)) this.shared.found.add(piece.at);
  }

  private char(ahead = 0): string | undefined {
    return this.p[this.i + ahead]?.char;
  }

  /**
   * Commands, to the end of the script or, with `closes`, to the `)` that ends a `$(`, `<(` or `>(`:
   * where that `)` is (it is read too).
   */
  private code(closes: boolean): number {
    const frames: Frame[] = [];
    let word: Word | undefined;
    let command = newCommand();
    let pipeline: Command[] = [];
    let redirect: 'in' | 'dup' | 'out' | 'append' | 'to' | 'here' | undefined;
    // The descriptor a redirection is for, where it says one.
    let descriptor: string | undefined;
    let atCommand = true;
    let assigned = false;
    // After `function`: its name comes next. After a function's name (and its `()`): its body.
    let naming = false;
    let defined = false;
    const pending: Heredoc[] = [];
    const top = () => frames.at(-1);
    const inCase = (...stages: Case['stage'][]) => {
      const frame = top();
      return frame?.kind === 'case' && stages.includes(frame.stage) ? frame : undefined;
    };

    const start = () => (word ??= { text: '', pieces: [], plain: true, made: false, open: false, specials: '' });
    const add = (piece: Piece, unquoted: boolean) => {
      const w = start();
      if (unquoted) {
        this.flag(piece);
        if ('{}[]*?,.'.includes(piece.char)) w.specials += piece.char;
      } else {
        w.plain = false;
      }
      if (piece.made) {
        w.made = true;
        w.plain = false;
        if (piece.made === 'command' || piece.made === 'process') command.substitutes = true;
      }
      w.pieces.push(piece);
    };
    const expanded = (made: Made) => add(expansion(made), false);
    const endWord = () => {
      if (word === undefined) return;
      // A pattern, or braces with a comma or `..` in them (`{}`, as find -exec has it, is no such).
      const w = { ...word, text: textOf(word.pieces), open: opens(word.specials) };
      word = undefined;
      if (redirect !== undefined) {
        const kind = redirect;
        redirect = undefined;
        const substituted = w.pieces.some((piece) => piece.made === 'command' || piece.made === 'process');
        const file = !w.made && !w.open ? w.text.split('/').pop()! : undefined;
        if (kind === 'here') command.inputs.push({ pieces: [...w.pieces, NEWLINE], exact: !w.made });
        else if (kind === 'dup' || (kind === 'in' && substituted)) command.inputs.push({ pieces: [], exact: false });
        else if (kind === 'in') {
          command.fromFile = true;
          command.from = file;
        }
        else if (kind === 'to' && /^(?:\d+|-)$/.test(w.text)) return;
        else if (descriptor === undefined || descriptor === '1' || descriptor === '&') command.writes.push({ file, append: kind === 'append' });
        return;
      }
      const frame = top();
      // An array's element with a subscript, which arithmetic reads (`a=([n]=1)`).
      const subscript = frame?.kind === 'array' ? /^\[([^\]]*)\]\+?=/.exec(w.text)?.[1] : undefined;
      if (subscript !== undefined && !arithmeticOf(subscript, (variable) => this.shared.across.counted.add(variable))) throw new Lost();
      if (frame?.kind === 'case' && frame.stage !== 'arm') {
        if (frame.stage === 'subject') frame.stage = 'in';
        else if (frame.stage === 'in') {
          if (!(w.plain && w.text === 'in')) throw new Lost();
          frame.stage = 'pattern';
          frame.patterns = 0;
        } else if (frame.patterns === 0 && w.plain && w.text === 'esac') {
          frames.pop();
          command.compound = true;
          command.words.push(w);
          atCommand = false;
        } else {
          frame.patterns += 1;
        }
        return;
      }
      const reserved = atCommand && !assigned && w.plain;
      if (reserved && w.text === 'case') {
        frames.push({ kind: 'case', stage: 'subject', patterns: 0 });
        if (command.words.length === 0) command.opens = true;
        command.words.push(w);
        return;
      }
      if (reserved && w.text === 'esac') {
        // Only in a case's commands; elsewhere a syntax error.
        if (!inCase('arm')) throw new Lost();
        frames.pop();
        command.compound = true;
        command.words.push(w);
        atCommand = false;
        return;
      }
      if (reserved && CLOSES.has(w.text)) command.compound = true;
      if (reserved && OPENS.has(w.text) && command.words.length === 0) command.opens = true;
      command.words.push(w);
      if (naming) {
        naming = false;
        this.shared.across.functions.add(w.text);
        w.defines = true;
        atCommand = true;
        defined = true;
        return;
      }
      defined = false;
      if (reserved && w.text === 'function') {
        naming = true;
        atCommand = false;
        return;
      }
      if (atCommand && !(reserved && BEFORE_COMMAND.has(w.text))) {
        if (ASSIGNMENT.test(w.text)) assigned = true;
        else atCommand = false;
      }
    };
    const endCommand = () => {
      endWord();
      if (redirect !== undefined) throw new Lost();
      if (command.words.length > 0 || command.inputs.length > 0 || command.compound || command.fromFile) {
        this.hands(command);
        this.wrote(command);
        pipeline.push(command);
      }
      command = newCommand();
      atCommand = true;
      assigned = false;
      defined = false;
    };
    const endPipeline = () => {
      endCommand();
      if (pipeline.length > 0) this.shared.pipelines.push(pipeline);
      pipeline = [];
    };

    for (;;) {
      const c = this.char();
      const next = this.char(1);
      if (c === undefined) {
        // A `$(`, a subshell, a case or an array never closed is a syntax error; so is a heredoc whose line never comes (bodies).
        endWord();
        if (closes || frames.length > 0 || naming) throw new Lost();
        endPipeline();
        return this.i;
      }
      let patterns = inCase('pattern');
      if (patterns && word !== undefined && breaks(c) && !blank(c) && c !== '\n') {
        // The word before decides: `esac` ends the case.
        endWord();
        patterns = inCase('pattern');
      }
      // What a case is about, and `in`: words only.
      if (inCase('subject', 'in') && !blank(c) && c !== '\n' && (breaks(c) || (c === '#' && word === undefined))) throw new Lost();
      if (blank(c)) {
        endWord();
        this.i += 1;
      } else if (c === '\n') {
        endWord();
        // A newline may come before `in` and before a pattern, not in what a case is about or among patterns.
        if (inCase('subject')) throw new Lost();
        const among = inCase('pattern');
        if (among) {
          if (among.patterns > 0) throw new Lost();
        } else if (!inCase('in') && top()?.kind !== 'array') {
          endPipeline();
        }
        this.i += 1;
        this.bodies(pending);
      } else if (c === '#' && word === undefined) {
        // A comment: text, to the end of its line.
        while (this.i < this.p.length && this.char() !== '\n') this.i += 1;
      } else if (c === '\\') {
        if (next === '\n') {
          this.i += 2;
        } else if (next === undefined) {
          add(this.p[this.i]!, true);
          this.i += 1;
        } else {
          add(this.p[this.i + 1]!, false);
          this.i += 2;
        }
      } else if (c === "'") {
        start().plain = false;
        this.single(add);
      } else if (c === '"') {
        start().plain = false;
        this.double(add);
      } else if (c === '`') {
        this.backquote(false);
        expanded('command');
      } else if (c === '$') {
        if (next === "'" || next === '"') start().plain = false;
        this.dollar(add, expanded, true);
      } else if (patterns && breaks(c)) {
        // A case's patterns: words, then `|` between them, and `)` after them.
        if (c === '|') {
          endWord();
          this.i += 1;
        } else if (c === ')') {
          endWord();
          if (patterns.patterns === 0) throw new Lost();
          // The commands of this pattern follow, each a command of its own.
          endPipeline();
          patterns.stage = 'arm';
          this.i += 1;
        } else if (c === '(' && word === undefined && patterns.patterns === 0) {
          this.i += 1;
        } else {
          // `(` in a pattern, `;`, `&`, `<` or `>`: past what this follows.
          throw new Lost();
        }
      } else if (c === ';') {
        const ends = next === ';' || (next === '&' || next === '|');
        endPipeline();
        if (ends) {
          // ;; ;& ;;& ;| end a case's commands; anywhere else a syntax error.
          const arm = inCase('arm');
          if (!arm) throw new Lost();
          arm.stage = 'pattern';
          arm.patterns = 0;
          this.i += next === ';' && this.char(2) === '&' ? 3 : 2;
        } else {
          this.i += 1;
        }
      } else if (c === '&') {
        if (next === '>') {
          endWord();
          redirect = this.char(2) === '>' ? 'append' : 'out';
          descriptor = '&';
          this.i += redirect === 'append' ? 3 : 2;
        } else {
          endPipeline();
          this.i += next === '&' ? 2 : 1;
        }
      } else if (c === '|') {
        if (next === '|') endPipeline();
        else endCommand();
        this.i += next === '|' || next === '&' ? 2 : 1;
      } else if ((c === '<' || c === '>') && next === '(') {
        // A process substitution, a word of its own: `<(…)` a file to read, `>(…)` one to write, whose commands read what is written to it.
        endWord();
        this.i += 2;
        if (c === '>') this.shared.across.risky = true;
        this.substitution();
        expanded('process');
      } else if (c === '<' || c === '>') {
        // A descriptor's number (or {name}) right before belongs to the redirection.
        descriptor = undefined;
        if (word !== undefined && word.plain && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(textOf(word.pieces))) {
          descriptor = textOf(word.pieces);
          word = undefined;
        }
        endWord();
        if (redirect !== undefined) throw new Lost();
        if (c === '<' && next === '<' && this.char(2) === '<') {
          this.i += 3;
          redirect = 'here';
        } else if (c === '<' && next === '<') {
          this.i += 2;
          const tabs = this.char() === '-';
          if (tabs) this.i += 1;
          const input: Input = { pieces: [], exact: true };
          command.inputs.push(input);
          pending.push({ ...this.delimiter(), tabs, input });
        } else {
          this.i += 1;
          const then = this.char();
          if (c === '<' && then === '&') {
            this.i += 1;
            redirect = 'dup';
          } else if (c === '<' && then === '>') {
            this.i += 1;
            redirect = 'in';
          } else if (c === '>' && then === '&') {
            // To another descriptor (`>&2`), or of both to a file (`>&file`).
            this.i += 1;
            redirect = 'to';
          } else {
            if (then === '>' || then === '|' || (c === '>' && then === '!')) this.i += 1;
            redirect = c === '<' ? 'in' : then === '>' ? 'append' : 'out';
          }
        }
      } else if (c === '(') {
        const keywords = command.words.every((w) => w.plain && BEFORE_COMMAND.has(w.text));
        if (word !== undefined) {
          const text = textOf(word.pieces);
          const declaring = command.words.length > 0 && DECLARES.has(command.words[0]!.text);
          if (word.plain && ARRAY.test(text) && (atCommand || declaring)) {
            // An array: its elements are words, comments allowed.
            endWord();
            frames.push({ kind: 'array' });
            this.i += 1;
          } else if (next === ')' && word.plain && (naming || (atCommand && !assigned && keywords))) {
            // A function's name: its body comes where a command would.
            this.shared.across.functions.add(text);
            endWord();
            command.words.at(-1)!.defines = true;
            naming = false;
            this.i += 2;
            atCommand = true;
            defined = true;
          } else {
            // A `(` in a word: a pattern in zsh, an error in bash.
            throw new Lost();
          }
        } else if (naming) {
          throw new Lost();
        } else if (next === ')' && defined) {
          // `function name ()`.
          this.i += 2;
        } else if (next === ')' && command.words.length === 1 && command.words[0]!.plain && !BEFORE_COMMAND.has(command.words[0]!.text) && !assigned) {
          // `name ()`.
          this.shared.across.functions.add(command.words[0]!.text);
          command.words[0]!.defines = true;
          this.i += 2;
          atCommand = true;
          defined = true;
        } else if (next === '(' && (atCommand || (command.words.length === 1 && command.words[0]!.text === 'for'))) {
          // (( … )), and for (( … )): arithmetic.
          this.i += 2;
          this.arithmetic();
          atCommand = false;
        } else if (atCommand && !assigned && (keywords || defined)) {
          frames.push({ kind: 'subshell' });
          defined = false;
          this.i += 1;
        } else {
          // Where an argument would be: a pattern in zsh, an error in bash.
          throw new Lost();
        }
      } else if (c === ')') {
        endWord();
        const frame = top();
        if (frame?.kind === 'subshell' || frame?.kind === 'array') {
          frames.pop();
          if (frame.kind === 'subshell') {
            // What follows is the subshell's: its redirections, its place in a pipeline.
            command.compound = true;
            atCommand = false;
          }
          this.i += 1;
        } else if (frame === undefined && closes) {
          endPipeline();
          // A heredoc asked for on the line a `$( )` ends: bash 5 reads its body after it, others do not.
          if (pending.length > 0) throw new Lost();
          this.i += 1;
          return this.i - 1;
        } else {
          // A `)` that closes nothing, or ends a case's commands: a syntax error.
          throw new Lost();
        }
      } else {
        add(this.p[this.i]!, true);
        this.i += 1;
      }
    }
  }

  /** A string in single quotes: all of it as it is. */
  private single(add: (piece: Piece, unquoted: boolean) => void): void {
    this.i += 1;
    const from = this.i;
    while (this.char() !== "'") {
      if (this.char() === undefined) throw new Lost();
      add(this.p[this.i]!, false);
      this.i += 1;
    }
    this.mayRun(this.p.slice(from, this.i));
    this.i += 1;
  }

  /**
   * Quoted text with a substitution's start in it (`$(`, `${`, a backquote), which the shell may
   * yet run as one, by a road this does not follow: arithmetic reads a variable's value as an
   * expression, and a subscript in it (`a[$(…)]`) runs; so do the names read, printf -v and
   * declare take; zsh's (e), (P) and (%) flags, bash's @P, print -P and PS4 expand it. Such a
   * character in it counts, as in a word.
   */
  private mayRun(pieces: readonly Piece[]): void {
    if (/\$[({]|`/.test(textOf(pieces))) for (const piece of pieces) this.flag(piece);
  }

  /** A string in double quotes, its expansions read as such. */
  private double(add: (piece: Piece, unquoted: boolean) => void): void {
    this.nest(() => {
      this.i += 1;
      // Its text, the expansions in it aside.
      const text: Piece[] = [];
      for (;;) {
        const c = this.char();
        const next = this.char(1);
        if (c === undefined) throw new Lost();
        if (c === '"') break;
        if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== '\n') {
            add(this.p[this.i + 1]!, false);
            text.push(this.p[this.i + 1]!);
          }
          this.i += 2;
        } else if (c === '`') {
          this.backquote(true);
          add(expansion('command'), false);
        } else if (c === '$') {
          this.dollar(add, (made) => add(expansion(made), false), false);
        } else {
          add(this.p[this.i]!, false);
          text.push(this.p[this.i]!);
          this.i += 1;
        }
      }
      this.mayRun(text);
      this.i += 1;
    });
  }

  /** What follows a `$`: a quote, a substitution, an expansion, or the `$` of a parameter. */
  private dollar(add: (piece: Piece, unquoted: boolean) => void, expanded: (made: Made) => void, unquoted: boolean): void {
    const next = this.char(1);
    if (unquoted && next === "'") {
      this.ansi(add);
    } else if (unquoted && next === '"') {
      this.i += 1;
      this.double(add);
    } else if (next === '(' && this.char(2) === '(') {
      this.i += 3;
      this.arithmetic();
      expanded('arithmetic');
    } else if (next === '(') {
      this.i += 2;
      this.substitution(this.heredoc ? 'expanded' : unquoted ? 'read' : 'quoted');
      expanded('command');
    } else if (next === '{') {
      // bash 5.3's (and ksh's) `${ cmd; }` and `${| cmd; }` run commands, which bash 3.2, zsh and dash do not.
      const after = this.char(2);
      if (after === undefined || blank(after) || after === '\n' || after === '|') throw new Lost();
      this.i += 2;
      const from = this.i;
      this.braces(unquoted);
      const inside = textOf(this.p.slice(from, this.i - 1));
      this.expansion(inside);
      if (/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])$/.test(inside)) add({ char: `\${${inside}}`, at: -1, made: 'parameter', name: inside }, false);
      // A length is a number (numeric).
      else if (/^#(?:[A-Za-z_][A-Za-z0-9_]*(?:\[[@*]\])?|[0-9@*#?$!_-])$/.test(inside)) add({ char: `\${${inside}}`, at: -1, made: 'parameter', name: '#' }, false);
      else expanded('parameter');
    } else if (next === '[') {
      // $[ … ], arithmetic of old: past what this follows.
      throw new Lost();
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      // $name: what the command sets it to, or the user's own.
      let end = this.i + 1;
      while (/^[A-Za-z0-9_]$/.test(this.p[end]?.char ?? '')) end += 1;
      const name = textOf(this.p.slice(this.i + 1, end));
      add({ char: `$${name}`, at: -1, made: 'parameter', name }, false);
      this.i = end;
    } else if (next !== undefined && /[0-9@*#?$!_-]/.test(next)) {
      // A positional or special parameter.
      add({ char: `$${next}`, at: -1, made: 'parameter', name: next }, false);
      this.i += 2;
    } else {
      const piece = this.p[this.i]!;
      add(next !== undefined && PARAMETER.test(next) ? { ...piece, made: 'parameter' } : piece, unquoted);
      this.i += 1;
    }
  }

  /**
   * A string in `$'…'`. Where it ends, every shell finds alike: a backslash takes the character
   * after it, whatever it is. What an escape stands for, where this does not know, is unknown.
   */
  private ansi(add: (piece: Piece, unquoted: boolean) => void): void {
    this.i += 2;
    const from = this.i;
    for (;;) {
      const c = this.char();
      if (c === undefined) throw new Lost();
      if (c === "'") {
        // What it stands for may hold a substitution's start its text does not show: an escape
        // that makes any character (`\x24` for `$`) counts as one.
        const text = this.p.slice(from, this.i);
        if (/\\[xuUc0-7]/.test(textOf(text))) for (const piece of text) this.flag(piece);
        else this.mayRun(text);
        break;
      }
      if (c !== '\\') {
        add(this.p[this.i]!, false);
        this.i += 1;
        continue;
      }
      const e = this.char(1);
      if (e === undefined) throw new Lost();
      // dash has no $'…': there the string ends at this quote.
      if (e === "'") throw new Lost();
      const known = ESCAPES[e];
      add(known === undefined ? expansion('escape') : { char: known, at: -1 }, false);
      // \c takes the character after it, \x, \u and \U the digits (zsh skips spaces before them):
      // a space other than a plain one there is part of the escape.
      if ('cxuU'.includes(e)) this.flag(this.p[this.i + 2]);
      this.i += 2;
    }
    this.i += 1;
  }

  /**
   * `$( )`, `<( )` or `>( )`: commands. bash 3.2 first finds where it ends (bash32End: as it reads
   * the command, in double quotes or not, or as it expands a heredoc's body), then reads what is
   * between as a script of its own.
   */
  private substitution(comments: Comments = 'read'): void {
    this.nest(() => {
      if (this.shared.dialect === 'modern') {
        this.code(true);
        return;
      }
      const start = this.i;
      const end = bash32End(this.p, start, comments, this.shared.depth);
      new Reader(this.p.slice(start, end), this.shared, true).script();
      this.i = end + 1;
    });
  }

  /**
   * What a `${…}` holds, read for what runs what a value holds, which is not followed: zsh's flags
   * (`(e)`, `(P)` and `(%)` run it as a substitution or a prompt, `(A)` and `::=` set an array of
   * its own), bash's `@P` and `${!x}`, which takes x's value for a name; a subscript or an offset,
   * which arithmetic reads (`${a[n]}`, `${x:n}`), as arithmetic is read; and setting what runs
   * (`${functions[f]:=…}`). Setting any other variable, its value is not known.
   */
  private expansion(inside: string): void {
    if (/^[(!]/.test(inside) || /@P$/.test(inside)) throw new Lost();
    const parts = /^#?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!_-])(?:\[([^\]]*)\])?([\s\S]*)$/.exec(inside);
    if (!parts) return;
    const [, name, subscript, rest] = parts as unknown as [string, string, string | undefined, string];
    const count = (variable: string) => this.shared.across.counted.add(variable);
    if (subscript !== undefined && subscript !== '@' && subscript !== '*' && !arithmeticOf(subscript, count)) throw new Lost();
    if (/^:(?![-=?+])/.test(rest) && !/^::=/.test(rest) && !arithmeticOf(rest.slice(1), count)) throw new Lost();
    if (/^(?::?:?=)/.test(rest)) {
      if (CODE_VARIABLES.test(name) || name === 'PATH' || name === 'path') throw new Lost();
      if (/^[A-Za-z_]/.test(name)) this.sets(name, null);
    }
  }

  /** `$(( ))` or `(( ))`: arithmetic, where `<<` shifts and `#` starts no comment. */
  private arithmetic(): void {
    this.nest(() => {
      let depth = 0;
      for (;;) {
        const c = this.char();
        if (c === undefined) throw new Lost();
        if (c === "'" || c === '"') throw new Lost();
        if (c === '(') {
          depth += 1;
          this.i += 1;
        } else if (c === ')') {
          if (depth > 0) {
            depth -= 1;
            this.i += 1;
          } else if (this.char(1) === ')') {
            this.i += 2;
            return;
          } else {
            // `$( (…) …)`: a subshell after all.
            throw new Lost();
          }
        } else if (c === '\\') {
          this.flag(this.p[this.i + 1]);
          this.i += 2;
        } else if (c === '$' && /^\$(?:[?#$!]|\(\(|\{#)/.test(textOf(this.p.slice(this.i, this.i + 3)))) {
          // `$?`, `$#` and the like, a length, arithmetic inside: numbers.
          this.dollar(() => {}, () => {}, true);
        } else if (c === '$' || (/[A-Za-z_]/.test(c) && !/[0-9A-Za-z_#]/.test(this.p[this.i - 1]?.char ?? ''))) {
          // A variable, by name (not a digit of `0x1f` or `16#ff`) or as `$name` or `${name}`: its value
          // is read as an expression, whose subscript runs (`n='a[$(…)]'; $(( n ))`), so it counts
          // (Across). What a substitution writes, an argument, or another expansion: not followed.
          const variable = /^\$?(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(textOf(this.p.slice(this.i, this.i + 256)));
          if (!variable || (c !== '$' && variable[0].startsWith('{'))) throw new Lost();
          this.shared.across.counted.add((variable[1] ?? variable[2])!);
          for (let n = 0; n < variable[0].length; n += 1) this.flag(this.p[this.i + n]);
          this.i += variable[0].length;
        } else if (c === '`') {
          throw new Lost();
        } else {
          this.flag(this.p[this.i]);
          this.i += 1;
        }
      }
    });
  }

  /**
   * `${ }`: a parameter, and the words of what it expands to, in double quotes or not. Before the
   * word an operator takes (the name, flags, the operator, an offset), each character decides what
   * the expansion is, so such a character counts there, in double quotes too.
   */
  private braces(unquoted: boolean): void {
    this.nest(() => {
      let inWord = false;
      let first = true;
      for (;;) {
        const c = this.char();
        if (c === undefined) throw new Lost();
        if (c === '}') {
          this.i += 1;
          return;
        }
        // bash and dash end it at the first `}`, zsh at the one that pairs with this `{`.
        if (c === '{') throw new Lost();
        if (!inWord && !first && '-=?+#%/'.includes(c)) inWord = true;
        first = false;
        const counts = unquoted || !inWord;
        if (c === '\\') {
          if (this.char(1) === undefined) throw new Lost();
          if (counts) this.flag(this.p[this.i + 1]);
          this.i += 2;
        } else if (c === "'" && unquoted) {
          this.single(() => {});
        } else if (c === '"') {
          this.double(() => {});
        } else if (c === '`') {
          this.backquote(!unquoted);
        } else if (c === '$') {
          this.dollar(() => {}, () => {}, unquoted);
        } else {
          // In "${ }" a single quote is a character like any other.
          if (counts) this.flag(this.p[this.i]);
          this.i += 1;
        }
      }
    });
  }

  /** Backquotes: their text, its escapes undone, is a script. */
  private backquote(inDouble: boolean): void {
    this.i += 1;
    const inner: Piece[] = [];
    for (;;) {
      const c = this.char();
      const next = this.char(1);
      if (c === undefined) throw new Lost();
      if (c === '`') break;
      if (c === '\\' && next !== undefined && ('$`\\'.includes(next) || (inDouble && next === '"'))) {
        inner.push(this.p[this.i + 1]!);
        this.i += 2;
      } else {
        inner.push(this.p[this.i]!);
        this.i += 1;
      }
    }
    this.i += 1;
    this.nest(() => new Reader(inner, this.shared).script());
  }

  /**
   * The word after `<<`: the line that ends the heredoc, and whether any of it is quoted (its body is
   * then as it is). Quoted or not, each of its characters decides where the heredoc ends. A
   * backslash and a newline join lines, as everywhere outside single quotes.
   */
  private delimiter(): { end: string; quoted: boolean } {
    const join = () => {
      while (this.char() === '\\' && this.char(1) === '\n') this.i += 2;
    };
    join();
    while (blank(this.char())) {
      this.i += 1;
      join();
    }
    // `<<` with no word: an error to bash and dash; zsh reads `<<(` as `< <(`, bash `<< <(…)` as a word.
    if (breaks(this.char())) throw new Lost();
    let end = '';
    let quoted = false;
    for (;;) {
      join();
      const c = this.char();
      if (breaks(c)) break;
      if (c === "'") {
        quoted = true;
        this.i += 1;
        while (this.char() !== "'") {
          if (this.char() === undefined) throw new Lost();
          this.flag(this.p[this.i]);
          end += this.char()!;
          this.i += 1;
        }
        this.i += 1;
      } else if (c === '"') {
        quoted = true;
        this.i += 1;
        for (;;) {
          const d = this.char();
          if (d === undefined) throw new Lost();
          if (d === '"') break;
          if (d === '$' || d === '`') throw new Lost();
          if (d === '\\' && this.char(1) === '\n') {
            this.i += 2;
            continue;
          }
          if (d === '\\' && this.char(1) !== undefined && '$`"\\'.includes(this.char(1)!)) this.i += 1;
          this.flag(this.p[this.i]);
          end += this.char()!;
          this.i += 1;
        }
        this.i += 1;
      } else if (c === '\\') {
        quoted = true;
        if (this.char(1) === undefined) throw new Lost();
        this.flag(this.p[this.i + 1]);
        end += this.char(1)!;
        this.i += 2;
      } else if (c === '$' || c === '`') {
        throw new Lost();
      } else {
        this.flag(this.p[this.i]);
        end += c;
        this.i += 1;
      }
    }
    return { end, quoted };
  }

  /** Heredoc bodies, from the line after the one that asked for them, each to its line. */
  private bodies(pending: Heredoc[]): void {
    for (const heredoc of pending.splice(0)) {
      const body: Piece[] = [];
      let ended = false;
      while (this.i < this.p.length) {
        // A line, with the next joined to it where an unquoted heredoc's line ends in a backslash.
        let at = this.i;
        if (heredoc.tabs) while (this.p[at]?.char === '\t') at += 1;
        const line: Piece[] = [];
        for (;;) {
          let stop = at;
          while (stop < this.p.length && this.p[stop]!.char !== '\n') stop += 1;
          const part = this.p.slice(at, stop);
          let backslashes = 0;
          while (backslashes < part.length && part[part.length - 1 - backslashes]!.char === '\\') backslashes += 1;
          if (!heredoc.quoted && stop < this.p.length && backslashes % 2 === 1) {
            line.push(...part.slice(0, -1));
            at = stop + 1;
            continue;
          }
          line.push(...part);
          if (stop < this.p.length) line.push(this.p[stop]!);
          this.i = stop < this.p.length ? stop + 1 : stop;
          break;
        }
        const text = textOf(line);
        if (text === heredoc.end || text === `${heredoc.end}\n`) {
          // The line that ends it: its characters are the delimiter's.
          for (const piece of line) this.flag(piece);
          ended = true;
          break;
        }
        body.push(...line);
      }
      // A heredoc whose line never comes: an error to some shells, the rest of the text to others,
      // or a sign this read its line otherwise; but in what bash 3.2 takes for a `$( )`, which may end in it.
      if (!ended && !this.cut) throw new Lost();
      heredoc.input.pieces = body;
      // An unquoted heredoc's body is expanded: what runs in it is a script; and as a script, it is
      // not known here once the shell has expanded or unescaped some of it.
      if (!heredoc.quoted) {
        if (body.some((piece) => '$`\\'.includes(piece.char))) heredoc.input.exact = false;
        new Reader(body, this.shared).heredocBody();
      }
    }
  }

  /** The body of an unquoted heredoc: text, but for `$( )`, `${ }`, `$(( ))` and backquotes. */
  private expansions(): void {
    while (this.i < this.p.length) {
      const c = this.char();
      const next = this.char(1);
      if (c === '\\') this.i += next !== undefined && '$`\\\n'.includes(next) ? 2 : 1;
      else if (c === '`') this.backquote(false);
      else if (c === '$') this.dollar(() => {}, () => {}, false);
      else this.i += 1;
    }
  }

  /** A script handed to a shell: `words`, joined by spaces (scriptOf). */
  private handOff(words: Word[]): void {
    this.shared.scripts.push(this.scriptOf(words));
  }

  /**
   * The text `words` make, joined by spaces, as the shell hands it on once it has expanded them:
   * a variable the command sets to plain text stands for that text, one it does not set (the
   * user's own) and `$?` and the like for a word of their own. Not known here (Lost): braces or a
   * pattern, a variable set to what this does not know or to quotes and the like, an argument
   * (`$1`, `$@`), a substitution, `${…}` with an operator, an escape in `$'…'` this does not know.
   */
  private scriptOf(words: Word[]): Piece[] {
    const script: Piece[] = [];
    for (const word of words) {
      if (word.open) throw new Lost();
      if (script.length > 0) script.push(SPACE);
      for (const piece of word.pieces) {
        if (!piece.made) {
          script.push(piece);
          continue;
        }
        const name = piece.made === 'parameter' ? piece.name : undefined;
        if (name === undefined || /^[0-9@*_]$/.test(name) || name === 'IFS') throw new Lost();
        const value = /^[?$!#-]$/.test(name) ? '0' : this.shared.across.values.get(name);
        if (value === null || (value !== undefined && !PLAIN.test(value))) throw new Lost();
        for (const char of value ?? 'x') script.push({ char, at: -1 });
      }
    }
    return script;
  }

  /**
   * What a command hands to a shell (the script after a shell's `-c`, what `eval` runs, and the
   * like), or whether it is a shell that reads its commands from its input; and what `echo`
   * writes. A shell's name is looked for among all its words, so as to find it where sudo, env,
   * find -exec or another program runs it.
   */
  private hands(command: Command): void {
    const words = command.words;
    let k = 0;
    // Past a function's definition (`function f`, `f()`), its body's first command; past `time`, its options.
    while (k < words.length && (words[k]!.defines || (words[k]!.plain && (BEFORE_COMMAND.has(words[k]!.text) || (words[k]!.text === 'function' && words[k + 1]?.defines))))) {
      k += 1;
      if (words[k - 1]!.text === 'time') while (k < words.length && /^-[A-Za-z]+$/.test(words[k]!.text)) k += 1;
    }
    while (k < words.length && ASSIGNMENT.test(words[k]!.text)) this.assigns(words[k++]!);
    k = this.pastModifiers(words, k);
    const first = words[k];
    if (first === undefined) return;
    if (first.open && /[{]/.test(first.text) && first.text !== '{') {
      // Braces may make the command's name of what shows as quoted text.
      throw new Lost();
    }
    const name = this.nameOf(first);
    // A command whose name is not known here may be one that runs text later (eval, alias, read):
    // not followed, as such a one is not.
    if (name === undefined) throw new Lost();
    const rest = words.slice(k + 1);
    if (name === null) {
      // A program that runs its arguments, named by a variable: they read as eval would read them.
      command.kind = 'runs';
      this.handOff(rest);
      return;
    }
    if (runsLater(name, first, rest, this.shared.across.ksh, (variable) => this.shared.across.counted.add(variable))) throw new Lost();
    if (DECLARING.has(name)) {
      // An option, or a name that is not plain (`'a[$(…)]=1'`, `"$x"`), may make it run what it
      // sets: not followed. Else it sets variables, as an assignment does.
      for (const word of rest) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\+?=|$)/.test(word.text)) throw new Lost();
        if (word.text.includes('=')) this.assigns(word);
      }
    }
    // A builtin macOS also has as a program (/usr/bin/read), run by a program that runs its arguments (WRAPPED).
    const runsArguments = EXEC_RUNNERS.has(name) && (name !== 'find' || rest.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word.text)));
    if (runsArguments && rest.some((word) => !word.made && WRAPPED.has(word.text.replace(/^\/usr\/bin\//, '')))) throw new Lost();
    // What env, or a program, hands a shell it starts in its environment. What env, sudo or doas
    // sets there for the program it runs is not known here.
    const passes = (word: Word) => ['env', 'sudo', 'doas'].includes(program(word));
    let environment = passes(first);
    for (const word of rest) {
      this.startsWith(word, environment);
      const named = environment ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.text)?.[1] : undefined;
      if (named !== undefined) this.sets(named, null);
      environment ||= passes(word);
    }
    // A script the command may have written, run by its path (`./fix.sh`).
    if (first.text.includes('/')) this.runsFile(first);
    if (name === 'for' && rest[1]?.text === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest[0]?.text ?? '')) {
      // for NAME in WORDS: one of them, each plain text; a number only where every one is.
      const each = rest.slice(2);
      const plain = each.length > 0 && each.every((word) => !word.made && !word.open && PLAIN.test(word.text) && !RUNNERS.has(program(word)) && !SHELLS.has(program(word)));
      this.sets(rest[0]!.text, plain ? (each.find((word) => !/^[-+]?[0-9]+$/.test(word.text)) ?? each[0]!).text : null);
    } else if (['for', 'select'].includes(name)) {
      // What sets a variable to what this does not follow.
      for (const word of rest) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) this.sets(word.text, null);
    }
    switch (name) {
      case 'echo': {
        command.kind = 'echo';
        // What bash, zsh and dash all write alike: words with no backslash (zsh's and dash's echo
        // take escapes), braces or patterns, and no option but -n.
        const shown = rest[0]?.text === '-n' ? rest.slice(1) : rest;
        if (!shown.some((word) => word.text.includes('\\')) && !shown[0]?.text.startsWith('-')) {
          try {
            const out = this.scriptOf(shown);
            if (!out.some((piece) => piece.char === '\\')) command.echoes = [...out, NEWLINE];
          } catch (error) {
            if (!(error instanceof Lost)) throw error;
          }
        }
        return;
      }
      case 'cat':
        if (rest.every((word) => word.text === '-' || word.text === '-u')) command.kind = 'cat';
        return;
      case 'exec':
        // Redirections alone: they stay for all that follows.
        if (rest.length === 0) {
          command.kind = 'runs';
          return;
        }
        break;
      case 'watch': {
        // watch runs its arguments, joined by spaces, with sh -c, but with -x (--exec).
        let m = 0;
        let exec = false;
        for (; m < rest.length; m += 1) {
          const option = rest[m]!.text;
          if (option === '--') {
            m += 1;
            break;
          }
          if (!option.startsWith('-')) break;
          if (/^-[A-Za-z]*x/.test(option) || option === '--exec') exec = true;
          if (/^-[A-Za-z]*[nq]$/.test(option) || option === '--interval' || option === '--equexit') m += 1;
        }
        if (!exec) {
          command.kind = 'runs';
          this.handOff(rest.slice(m));
          return;
        }
        break;
      }
      case 'sudo': {
        // sudo -s or -i runs its command with the user's shell, escaped its own way.
        const shelled = (word: Word) => (/^-[A-Za-z]*$/.test(word.text) && /[si]/.test(word.text)) || word.text === '--shell' || word.text === '--login';
        if (rest.some(shelled)) {
          const after = rest.findIndex(shelled);
          if (rest.slice(after + 1).some((word) => !word.text.startsWith('-'))) throw new Lost();
          command.kind = 'shell';
          return;
        }
        break;
      }
      default:
    }
    let launched = false;
    for (let j = k; j < words.length; j += 1) {
      const word = words[j]!;
      const at = j === k ? name : program(word);
      if (at === 'xargs' || at === 'parallel') {
        // They give a shell they start what they read.
        launched = true;
      } else if (at === 'eval' && j > k) {
        command.kind = 'runs';
        this.handOff(words.slice(j + 1));
        return;
      } else if (at === 'su' || at === 'flock' || at === 'script') {
        const option = words.slice(j + 1).findIndex((w) => /^-[A-Za-z]*c$/.test(w.text) || w.text === '--command');
        const long = words.slice(j + 1).find((w) => w.text.startsWith('--command='));
        if (option >= 0) {
          const script = words[j + 2 + option];
          if (script === undefined) throw new Lost();
          command.kind = 'runs';
          this.handOff([script]);
          return;
        }
        if (long) {
          command.kind = 'runs';
          this.handOff([{ ...long, pieces: long.pieces.slice('--command='.length) }]);
          return;
        }
        // su with no command starts a shell that reads its input.
        if (at === 'su') {
          command.kind = 'shell';
          return;
        }
      } else if (at === 'ssh') {
        this.ssh(command, words.slice(j + 1), j === k);
        return;
      } else if (at === 'env') {
        // env -S splits its string into a command, much as a shell reads one.
        const split = words.slice(j + 1).findIndex((w) => /^-[A-Za-z]*S/.test(w.text) || w.text.startsWith('--split-string'));
        if (split >= 0) {
          const option = words[j + 1 + split]!;
          const attached = /^-[A-Za-z]*S(.+)$/.exec(option.text) ?? /^--split-string=(.+)$/.exec(option.text);
          const string = attached ? { ...option, pieces: option.pieces.slice(option.text.length - attached[1]!.length) } : words[j + 2 + split];
          if (string === undefined) throw new Lost();
          command.kind = 'runs';
          this.handOff([{ ...string, text: textOf(string.pieces) }]);
          return;
        }
      } else if (SHELLS.has(at)) {
        if (launched) throw new Lost();
        if (at === 'ksh' || at === 'ksh93') this.shared.across.ksh = true;
        this.shell(command, words.slice(j + 1));
        return;
      }
    }
  }

  /**
   * Where the command's name is, past what a shell runs the command after as it is (`command`,
   * `builtin`, zsh's `exec`, `noglob`, `nocorrect` and `-`, `time -p`, `jobs -x`, `coproc`) and
   * their options: a builtin after them runs as a builtin, `command eval '…'` as eval.
   */
  private pastModifiers(words: Word[], k: number): number {
    for (;;) {
      const word = words[k];
      const name = word && !word.made && !word.open ? program(word) : undefined;
      if (name === undefined || !MODIFIERS.has(name) || (name === 'jobs' && words[k + 1]?.text !== '-x')) return k;
      let m = k + 1;
      while (words[m] !== undefined && /^-[A-Za-z]+$/.test(words[m]!.text)) m += /^-[A-Za-z]*a$/.test(words[m]!.text) && name === 'exec' ? 2 : 1;
      // `exec` with redirections alone keeps them for what follows (hands).
      if (words[m] === undefined) return name === 'exec' ? k : m;
      // A coprocess reads what the command writes to it, from anywhere.
      if (name === 'coproc') this.shared.across.risky = true;
      k = m;
    }
  }

  /**
   * What a command writes to files: what `cat` reads or `echo` writes, else not known here. Two
   * things written to one file, or added to it: not known which a script finds there.
   */
  private wrote(command: Command): void {
    const files = this.shared.across.files;
    const words = command.words.filter((word) => !ASSIGNMENT.test(word.text));
    const name = words[0] === undefined ? undefined : program(words[0]);
    const operands = words.slice(1).filter((word) => !word.text.startsWith('-'));
    const named = (word: Word) => (!word.made && !word.open ? program(word) : undefined);
    if (name === 'tee') {
      // What tee reads goes in each file it names: its own heredoc, else not known here.
      const content = command.inputs.length === 1 && !words.slice(1).some((word) => word.text === '-a' || word.text === '--append') ? command.inputs[0]! : null;
      for (const word of operands) command.writes.push({ file: named(word), append: content === null });
      if (content !== null) for (const write of command.writes) if (!write.append && write.file !== undefined) files.set(write.file, [...(files.get(write.file) ?? []), content]);
      for (const write of command.writes) if (write.append && write.file !== undefined) files.set(write.file, null);
      return;
    }
    // What a file holds once it is copied, moved, linked or edited in place: not known here.
    const changes = ['cp', 'mv', 'ln', 'install', 'rsync', 'ditto', 'dd'].includes(name ?? '') ? operands.slice(-1)
      : ['sed', 'perl', 'gsed'].includes(name ?? '') && words.some((word) => /^-[a-zA-Z]*i/.test(word.text) || word.text.startsWith('--in-place')) ? operands
      : ['patch', 'ed', 'ex', 'vi', 'vim', 'nano', 'truncate', 'touch', 'unzip', 'tar', 'curl', 'wget', 'git'].includes(name ?? '') ? operands
      : [];
    for (const word of changes) {
      const file = named(word);
      if (file === undefined) continue;
      files.set(file, null);
      // A copy, a link or an install may be a program.
      if (['cp', 'mv', 'ln', 'install', 'rsync', 'ditto'].includes(name ?? '')) this.shared.across.executables.add(file);
    }
    // What it makes a program: chmod with a mode that sets x.
    if (name === 'chmod' && operands.length > 1 && /x|[1357]/.test(operands[0]!.text)) {
      for (const word of operands.slice(1)) {
        const file = named(word);
        if (file !== undefined) this.shared.across.executables.add(file);
      }
    }
    for (const { file, append } of command.writes) {
      if (file === undefined) continue;
      const content = append ? null
        : command.kind === 'cat' && command.inputs.length === 1 ? command.inputs[0]!
        : command.kind === 'echo' && command.echoes ? { pieces: command.echoes, exact: true }
        : null;
      const known = files.get(file);
      // A heredoc's body is read after its line: what went in is compared once the file runs.
      files.set(file, content === null || known === null ? null : [...(known ?? []), content]);
    }
  }

  /** A file the command runs as a script (or reads as one): read once what it writes in it is known. */
  private runsFile(word: Word | undefined): void {
    if (word !== undefined && !word.made && !word.open) this.shared.across.runs.add(program(word));
  }

  /** A word that sets a variable: what to, where it is plain text this knows (no expansion, pattern, quote or the like in it). */
  private assigns(word: Word): void {
    const equals = word.text.indexOf('=');
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word.text)![0];
    // A function or an alias of zsh's, made by setting its arrays, or a prompt, which bash and zsh
    // expand (PS4 at each command set -x traces): what the value runs, this does not follow. A
    // subscript of an array is arithmetic, which runs what a variable it names holds (`a[n]=1`).
    if (CODE_VARIABLES.test(name)) throw new Lost();
    const subscript = /^\[([^\]]*)\]/.exec(word.text.slice(name.length))?.[1];
    if (subscript !== undefined && !arithmeticOf(subscript, (variable) => this.shared.across.counted.add(variable))) throw new Lost();
    this.startsWith(word);
    const pieces = word.pieces.slice(equals + 1);
    const value = textOf(pieces);
    // What arithmetic gives is a number (`n=$((n + 1))`); an element of an array, or what adds to
    // the value, is not known.
    const number = pieces.length > 0 && pieces.every((piece) => piece.made === 'arithmetic' || (!piece.made && /^[0-9]$/.test(piece.char)));
    this.sets(name, equals !== name.length ? null : number ? '0' : !word.made && !word.open && PLAIN.test(value) ? value : null);
  }

  /**
   * A setting a shell reads as it starts, wherever it is (`BASH_ENV=./f.sh bash -c …`, or among
   * env's arguments): the file BASH_ENV or ENV names is a script it runs, read once what the command
   * writes in it is known; ZDOTDIR's .zshenv is among the files every shell started reads (shell).
   * A function bash takes from the environment (`BASH_FUNC_f%%=() { … }`) runs what it holds.
   */
  private startsWith(word: Word, environment = true): void {
    if (/^BASH_FUNC_[^=]*(?:%%|\(\))=/.test(word.text)) throw new Lost();
    // In an assignment, or set by env for what it runs: a prompt or the like a shell expands
    // (`env PS4='…' bash -xc :`), a number, where programs are found.
    const named = environment ? /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(word.text)?.[1] : undefined;
    if (named !== undefined && CODE_VARIABLES.test(named)) throw new Lost();
    // A value a shell reads as arithmetic (NUMERIC_VARIABLES): a number, or a variable it counts.
    if (named !== undefined && NUMERIC_VARIABLES.test(named)) {
      const value = word.pieces.slice(word.pieces.findIndex((piece) => piece.char === '=') + 1);
      const text = textOf(value);
      if (!(text === '' || sideOf({ ...word, text, pieces: value, made: value.some((piece) => piece.made), plain: !value.some((piece) => piece.made) }, (variable) => this.shared.across.counted.add(variable)))) throw new Lost();
    }
    // Where a shell finds a program by its name: a file the command writes may run by its name alone.
    if (named === 'PATH' || named === 'path') this.shared.across.path = true;
    const setting = /^(?:BASH_ENV|ENV)=/.exec(word.text);
    if (!setting) return;
    const value = word.pieces.slice(setting[0].length);
    if (value.some((piece) => piece.made)) throw new Lost();
    this.shared.across.runs.add(textOf(value).split('/').pop()!);
  }

  /** What the command sets a variable to; set to two things, it is not known which a script sees. */
  private sets(name: string, value: string | null): void {
    const values = this.shared.across.values;
    const known = values.get(name);
    const number = (text: string | null | undefined) => typeof text === 'string' && /^[-+]?[0-9]+$/.test(text);
    // Set to two numbers, it is a number still (Across.counted).
    values.set(name, !values.has(name) || known === value ? value : number(known) && number(value) ? '0' : null);
  }

  /**
   * The name of the program a word runs, where this can tell: the last part of its path, or what
   * the command set the variable it expands to (`$PY` after `PY=/usr/bin/python3`). A variable the
   * command does not set is the user's own: a program, but for `$SHELL`, `$BASH`, `$0` and zsh's
   * name for itself, which are shells. What an argument, `$_` (the last word of the command before)
   * or the command bash runs stands for is not known (undefined): `set -- eval …` makes `"$@"` eval.
   * A variable set to a program that runs its arguments (`K='timeout 9 kubectl'`) gives null.
   */
  private nameOf(word: Word): string | null | undefined {
    if (!word.made && !word.open) return program(word);
    const slash = word.pieces.map((piece) => piece.char).lastIndexOf('/');
    const tail = word.pieces.slice(slash + 1);
    if (slash >= 0 && !tail.some((piece) => piece.made) && !/[*?[]/.test(textOf(tail))) return textOf(tail);
    const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(word.text)?.[1] ?? (word.pieces.length === 1 ? word.pieces[0]!.name : undefined);
    if (variable === undefined || /^(?:[1-9@*_]|BASH_COMMAND|BASH_ARGV|BASH_REMATCH|FUNCNAME|REPLY|OPTARG|MAPFILE|MATCH|match)$/.test(variable)) return undefined;
    if (['SHELL', 'BASH', '0', 'ZSH_NAME', 'ZSH_ARGZERO'].includes(variable)) return 'sh';
    const value = this.shared.across.values.get(variable);
    if (value === undefined) return '';
    const parts = value?.trim().split(/[ \t]+/).map((part) => part.split('/').pop()!);
    if (parts === undefined || parts.some((part) => RUNS_LATER.has(part) || MODIFIERS.has(part) || DECLARING.has(part) || WRAPPED.has(part))) return undefined;
    return parts.some((part) => RUNNERS.has(part) || SHELLS.has(part)) ? null : parts[0];
  }

  /** A shell's options and what it runs: the script after `-c`, its input, or a file. */
  private shell(command: Command, args: Word[]): void {
    // Braces or a pattern may make `-c` and a script of what shows as one word.
    if (args.some((word) => word.open)) throw new Lost();
    // The files a shell reads as it starts, in the home folder or where ZDOTDIR says: scripts it
    // runs, should the command write one.
    for (const file of STARTUP_FILES) this.shared.across.runs.add(file);
    let script = false;
    let input = false;
    let m = 0;
    for (; m < args.length; m += 1) {
      const word = args[m]!;
      const option = word.text;
      if (word.made || word.open) {
        // An option this cannot read; or the script, or a file, which come next (scriptOf says what of it is known).
        if (option.startsWith('-') && !script) throw new Lost();
        break;
      }
      if (option === '-' || option === '--') {
        m += 1;
        break;
      }
      if (option.startsWith('--')) {
        // The file it reads as it starts is a script it runs.
        if (['--rcfile', '--init-file'].includes(option)) this.runsFile(args[m + 1]);
        if (['--rcfile', '--init-file', '--emulate'].includes(option)) m += 1;
        continue;
      }
      if (!/^[-+][A-Za-z]+$/.test(option)) break;
      if (option.startsWith('-') && option.includes('c')) script = true;
      if (option.startsWith('-') && option.includes('s')) input = true;
      if (/[oO]$/.test(option)) m += 1;
    }
    if (script) {
      command.kind = 'runs';
      // No script among its words: it comes from what this does not see (xargs, a variable).
      if (args[m] === undefined) throw new Lost();
      this.handOff([args[m]!]);
      return;
    }
    const file = args[m];
    if (input || file === undefined || /^(?:\/dev\/stdin|\/dev\/fd\/\d+|-)$/.test(file.text)) {
      command.kind = 'shell';
      return;
    }
    // A script file made by a substitution has text of the command line; one the command writes, too.
    if (file.pieces.some((piece) => piece.made === 'command' || piece.made === 'process')) throw new Lost();
    this.runsFile(file);
  }

  /** ssh's options, where it goes, and the command its arguments make: the remote shell runs them joined by spaces. */
  private ssh(command: Command, args: Word[], first: boolean): void {
    const takes = 'BbcDEeFIiJLlmOoPpQRSWw';
    let m = 0;
    for (; m < args.length; m += 1) {
      const option = args[m]!.text;
      if (option === '--') {
        m += 1;
        break;
      }
      if (!option.startsWith('-') || option === '-') break;
      for (let x = 1; x < option.length; x += 1) {
        if (takes.includes(option[x]!)) {
          if (x === option.length - 1) m += 1;
          break;
        }
      }
    }
    const remote = args.slice(m + 1);
    if (remote.length === 0) {
      // Where it goes and no command: its input runs in the shell there.
      if (first && args[m] !== undefined) command.kind = 'shell';
      return;
    }
    this.handOff(remote);
    // A shell there that reads its commands from its input (`ssh host 'bash -s'`) reads this one's.
    const parts = remote.map((word) => word.text).join(' ').trim().split(/[ \t]+/);
    const options = parts.slice(1);
    const reads = SHELLS.has(parts[0]!.split('/').pop()!) && options.every((part, i) => /^[-+][A-Za-z]+$/.test(part) ? !/^-[A-Za-z]*c/.test(part) : /^[-+]o$/.test(options[i - 1] ?? '') || options.slice(0, i).some((before) => /^-[A-Za-z]*s/.test(before)));
    command.kind = reads ? 'shell' : 'runs';
  }
}

/** A word that is a number as it is: digits, or `$?`, `$#`, `$$`, `$!` or a length (`${#x}`), which are numbers. */
const numeric = (word: Word) => (!word.made && /^[-+]?[0-9]+$/.test(word.text)) || (word.pieces.length === 1 && /^[?#$!]$/.test(word.pieces[0]!.name ?? ''));

/**
 * Whether arithmetic may read a word, as a number or a variable (`count` takes its name: its value
 * is judged once the command is read). Anything else it would read as an expression: not followed.
 */
const sideOf = (word: Word, count: (name: string) => void): boolean => {
  if (numeric(word)) return true;
  const name = word.pieces.length === 1 && word.pieces[0]!.made === 'parameter' ? word.pieces[0]!.name : !word.made && word.plain ? word.text : undefined;
  if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  count(name);
  return true;
};

/**
 * Whether a command that `name` runs, with these words after it, may run text later, or set a
 * variable whose name the text gives (RUNS_LATER): so may a builtin in some of its forms, read
 * here as they were tried in bash, zsh, ksh and dash. printf with `-v` sets one; in a command that
 * hands ksh a script (`ksh`), ksh reads a number printf writes, shift's and ulimit's, and the sides
 * of `-eq` and the like in `test` (as bash does in `[[ ]]`) as arithmetic, which runs a subscript's
 * substitution; zsh's print -P and -v and set -A, bash's `-v` and `-R` tests, `wait -p` and
 * `hash -p` do too. Such a command is not followed.
 */
function runsLater(name: string, first: Word, rest: Word[], ksh: boolean, count: (name: string) => void): boolean {
  if (RUNS_LATER.has(name)) return true;
  const side = (word: Word | undefined) => word !== undefined && sideOf(word, count);
  const options = rest.filter((word) => /^[-+][A-Za-z]+$/.test(word.text)).map((word) => word.text);
  switch (name) {
    case 'printf': {
      if (options.some((option) => /^-[A-Za-z]*v/.test(option))) return true;
      const args = rest[0]?.text === '--' ? rest.slice(1) : rest;
      const format = args[0];
      // A number it writes (or a width or a precision it takes), from what is not a number.
      const specs = format?.text.replace(/%%/g, '').match(/%[^A-Za-z%]*[A-Za-z(]?/g) ?? [];
      const numbers = format?.made || specs.some((spec) => !/^%[-+ #0']*[0-9]*(?:\.[0-9]*)?[sbq]$/.test(spec));
      return ksh && Boolean(numbers) && args.slice(1).some((word) => !side(word));
    }
    case 'print':
      return options.some((option) => /^-[A-Za-z]*[Pvz]/.test(option));
    case 'set':
      return options.some((option) => /^[-+][A-Za-z]*A/.test(option));
    case 'wait':
      return options.some((option) => /^-[A-Za-z]*p/.test(option));
    case 'hash':
      return options.some((option) => /^-[A-Za-z]*p/.test(option)) || rest.some((word) => word.text.includes('='));
    case 'shift':
    case 'ulimit':
      return ksh && rest.some((word) => !word.text.startsWith('-') && !side(word) && !['unlimited', 'hard', 'soft'].includes(word.text));
    default:
  }
  // `[[ ]]`, and ksh's `test` and `[`: the words of a `[[ ]]` after its `&&` or `||` are a command of their own here.
  const brackets = name === '[[' || rest.at(-1)?.text === ']]';
  if (brackets || name === '[' || name === 'test') {
    const all = [first, ...rest];
    if (all.some((word) => word.text === '-v' || word.text === '-R')) return true;
    return (brackets || ksh) && all.some((word, i) => NUMERIC_TEST.test(word.text) && !(side(all[i - 1]) && side(all[i + 1])));
  }
  return false;
}

/**
 * What a pipeline feeds a shell that reads its commands from its input, once its heredocs are read:
 * the scripts to read. Only through what passes text on as it is (echo, cat) does this know what
 * the shell reads; else, where it is text of the command line, it is not known.
 */
function judge(pipeline: Command[], shared: Shared): void {
  const across = shared.across;
  pipeline.forEach((command, s) => {
    const fed = s > 0 || command.inputs.length > 0;
    if (fed) {
      if (command.compound || (command.opens && s > 0) || command.kind === 'runs' || command.substitutes) across.risky = true;
      // What runs a script it is handed, fed: the script may hand on what it reads to a shell.
      if (command.kind === 'runs') across.readsInput = true;
      const name = command.words.find((word) => !ASSIGNMENT.test(word.text) && !(word.plain && BEFORE_COMMAND.has(word.text)));
      if (name) across.fed.add(program(name));
    }
    if (pipeline.length > 1 && command.compound) across.risky = true;
    if (command.kind !== 'shell') return;
    across.readsInput = true;
    // A shell that reads a file the command writes reads what goes in it.
    if (command.from !== undefined) across.runs.add(command.from);
    const script = feeding(pipeline, s);
    if (script !== undefined) shared.scripts.push(script);
  });
}

/** The script that comes in at the input of the shell `pipeline[s]`; undefined where it is none of the command line's. */
function feeding(pipeline: Command[], s: number): Piece[] | undefined {
  const exact = (input: Input) => {
    if (!input.exact) throw new Lost();
    return input.pieces;
  };
  for (let k = s; k >= 0; k -= 1) {
    const command = pipeline[k]!;
    if (command.compound) throw new Lost();
    if (k < s && command.kind === 'echo') {
      if (command.echoes === undefined) throw new Lost();
      return command.echoes;
    }
    if (k < s && command.kind !== 'cat') throw new Lost();
    if (command.inputs.length > 1 || (command.inputs.length === 1 && command.fromFile)) throw new Lost();
    if (command.inputs.length === 1) return exact(command.inputs[0]!);
    if (command.fromFile) return undefined;
  }
  // The input of the whole command: Claude Code gives a command none.
  return undefined;
}

/**
 * The files the command writes and runs as scripts: what goes in each is a script to read, but
 * where its first line names another program than a shell (`#!/usr/bin/env python3`).
 */
function ranFiles(shared: Shared): void {
  const { files, runs } = shared.across;
  // Where the command sets PATH, a file it writes and makes a program may run by its name alone.
  if (shared.across.path) for (const file of shared.across.executables) runs.add(file);
  for (const file of runs) {
    if (!files.has(file)) continue;
    runs.delete(file);
    const written = files.get(file);
    const content = written?.[0];
    if (!content || written!.some((each) => !each.exact || textOf(each.pieces) !== textOf(content.pieces))) throw new Lost();
    const shebang = /^#!\s*(\S+)((?:[ \t]+\S+)*)/.exec(textOf(content.pieces.slice(0, 200)).split('\n')[0]!);
    const named = shebang ? [shebang[1]!, ...shebang[2]!.trim().split(/[ \t]+/)].map((part) => part.split('/').pop()!) : [];
    const runner = named[0] === 'env' ? named.slice(1).find((part) => part !== '' && !part.startsWith('-')) : named[0];
    if (runner === undefined || SHELLS.has(runner)) shared.scripts.push(content.pieces);
  }
}

/**
 * Where a `#` starts a comment as bash 3.2 finds where a `$(`, `<(` or `>(` ends: as it reads the
 * command, after a space, a tab or a newline it has read (a backslash and a newline are gone), but
 * not first in it, and never in double quotes; as it expands a heredoc's body, after a space, a tab
 * or a newline.
 */
type Comments = 'read' | 'quoted' | 'expanded';

/**
 * Where bash 3.2 (macOS's /bin/bash and /bin/sh) ends a `$(`, `<(` or `>(` whose text starts at
 * `at`: the index of its `)`. It counts parentheses, skips what is quoted or escaped and a comment
 * (Comments), and takes no notice of a heredoc, a case or `${ }`. Never closed: Unclosed.
 */
function bash32End(p: readonly Piece[], at: number, comments: Comments, depth: number): number {
  if (depth > MOST_DEPTH) throw new Lost();
  let i = at;
  const char = (k: number) => p[k]?.char;
  /** From after an opening quote or backquote to after its close: with `escapes`, a backslash takes the next character. */
  const quoted = (close: string, escapes: boolean, level: number) => {
    if (level > MOST_DEPTH) throw new Lost();
    for (;;) {
      const c = char(i);
      if (c === undefined) throw new Unclosed();
      i += 1;
      if (c === close) return;
      if (c === '\\' && escapes) i += 1;
      else if (close === '"' && c === '`') quoted('`', true, level + 1);
      else if (close === '"' && c === '$' && char(i) === '(') i = bash32End(p, i + 1, comments === 'expanded' ? 'expanded' : 'quoted', level + 1) + 1;
      else if (close === '"' && c === '$' && char(i) === '{') {
        i += 1;
        braced(level + 1);
      }
    }
  };
  /** `${…}` in double quotes: to its first `}`, quotes skipped. */
  const braced = (level: number) => {
    for (;;) {
      const c = char(i);
      if (c === undefined) throw new Unclosed();
      i += 1;
      if (c === '}') return;
      if (c === '\\') i += 1;
      else if (c === "'" || c === '"' || c === '`') quoted(c, c !== "'", level + 1);
    }
  };
  let parens = 1;
  let comment = false;
  // What came before: the character bash 3.2 read last (a backslash and a newline are gone).
  let before: string | undefined;
  for (;;) {
    const c = char(i);
    if (c === undefined) throw new Unclosed();
    const after = comments === 'expanded' ? char(i - 1) : before;
    if (comment) {
      if (c === '\n') comment = false;
    } else if (c === '#' && comments !== 'quoted' && (after === ' ' || after === '\t' || after === '\n')) {
      comment = true;
    } else if (c === '\\') {
      i += 1;
      if (char(i) === undefined) throw new Unclosed();
      if (char(i) === '\n') {
        i += 1;
        continue;
      }
    } else if (c === ')') {
      parens -= 1;
      if (parens === 0) return i;
    } else if (c === '(') {
      parens += 1;
    } else if (c === "'" || c === '"' || c === '`') {
      const dollar = before === '$';
      i += 1;
      quoted(c, c !== "'" || dollar, depth + 1);
      i -= 1;
    }
    before = char(i);
    i += 1;
  }
}

/**
 * Where, of the characters `asked` matches, a shell reads one as part of a word in `command` (their
 * offsets); undefined where this cannot tell, and every one counts (see above).
 */
export function inWords(command: string, asked: (char: string) => boolean): Set<number> | undefined {
  const found = new Set<number>();
  const pieces = [...command.matchAll(/[\s\S]/gu)].map((match) => ({ char: match[0], at: match.index }));
  const across: Across = { readsInput: false, risky: false, functions: new Set(), fed: new Set(), path: false, executables: new Set(), counted: new Set(), ksh: false, values: new Map(), files: new Map(), runs: new Set() };
  // What all the readings may read, scripts handed on again and again (`eval eval eval …`) among them.
  let budget = 4 * pieces.length + 200_000;
  try {
    for (const dialect of ['modern', 'bash32'] as const) {
      const shared: Shared = { asked, found, scripts: [pieces], pipelines: [], dialect, depth: 0, across };
      for (let k = 0; k < shared.scripts.length; k += 1) {
        if (k >= MOST_SCRIPTS || (budget -= shared.scripts[k]!.length) < 0) return undefined;
        new Reader(shared.scripts[k]!, shared).script();
        for (const pipeline of shared.pipelines.splice(0)) judge(pipeline, shared);
        ranFiles(shared);
      }
    }
  } catch (error) {
    // Lost, or a command nested deeper than the stack goes. Anything else is a mistake here: the
    // approval still shows, every such space written out, rather than not at all.
    if (!(error instanceof Lost || error instanceof RangeError)) console.error('Pelican could not read a command for its spaces', error);
    return undefined;
  }
  // Arithmetic reads a variable the command sets to what is not a number (or not known): what that
  // holds may be a subscript, which runs (`n='a[$(…)]'; $(( n ))`), wherever in the command it is set.
  for (const name of across.counted) {
    const value = across.values.get(name);
    // The shell sets these to text of the command: `$_` to the last word of the command before.
    if (/^(?:_|BASH_COMMAND|BASH_ARGV|BASH_REMATCH|FUNCNAME|REPLY|OPTARG|MAPFILE|MATCH|match)$/.test(name)) return undefined;
    if (value !== undefined && !/^[-+]?[0-9]+$/.test(value ?? '')) return undefined;
  }
  // A shell reads its input, and something may hand it text of the command line this does not follow.
  if (across.readsInput && (across.risky || [...across.fed].some((name) => across.functions.has(name)))) return undefined;
  // ksh93 ends a `<<#` heredoc at a line with blanks before its end, which bash, zsh and dash take for its body.
  if (across.ksh && command.includes('<<#')) return undefined;
  return found;
}

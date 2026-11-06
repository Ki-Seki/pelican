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
 * subshell, a case, a function and an array too. It follows a script the command hands to a shell:
 * the one after `-c` of sh, bash, zsh, dash, ksh and the like (also where sudo, env, find -exec or
 * another program runs them), of su, flock or script, what `eval`, `trap` or an alias runs, the
 * command ssh or watch runs, and what a heredoc, a here-string, `echo` or `cat` feeds a shell that
 * reads its commands from its input (`bash <<EOF`, `echo … | sh`, `ssh host 'bash -s' <<EOF`), and
 * a file the command writes with them and then runs or reads as a script (`cat > fix.sh <<'EOF' …
 * EOF`, then `bash fix.sh`, `./fix.sh` or `sh < fix.sh`; found by the last part of its name). In
 * such a script a variable the command sets to plain text stands for that text, and one it does not
 * set, the user's own, for a word of its own.
 *
 * Where it cannot tell, every such character counts as in a word (inWords gives undefined): a
 * syntax error (a quote never closed, a heredoc whose line never comes, a `)` that closes nothing),
 * which may be one only here; what the shells read otherwise (`<<(`, a `(` where an argument would
 * be, a `{` inside `${ }`, `${ cmd; }`, `$'…\'…'`, quotes inside `$(( ))`, `$[ ]`); a script handed to
 * a shell with text in it this does not know (a substitution, an argument such as `$1`, a variable
 * set to what this does not know, braces or a pattern; what printf, xargs or a filter make); text
 * of the command that may reach a shell's input any other way (through a loop, a function, `exec`,
 * a subshell, a coprocess or a command whose name this does not know); a file the command writes
 * and runs as a script with what this does not know in it (from printf, an unquoted heredoc that
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

/** Commands whose `name=(…)` is an array. */
const DECLARES = new Set(['declare', 'typeset', 'local', 'readonly', 'export', 'integer', 'float']);

/** A word that assigns, after which the command's name may still come; and one that opens an array, `name=(`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const ARRAY = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;

/** What `$'…'` makes of an escape that stands for one character this knows. */
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** What follows a `$` in zsh's `$=x`, `$~x`, `$^x` and `$+x`: an expansion too. */
const PARAMETER = /^[=~^+]$/;

/** Text a variable may stand for in a script handed on with no change to its quotes or commands. */
const PLAIN = /^[A-Za-z0-9_.\/:@%+=,~ \t-]*$/;

/** Programs that run what they are given, or what follows them, so a variable that names one is not known. */
const RUNNERS = new Set(['eval', 'source', '.', 'exec', 'trap', 'alias', 'su', 'sudo', 'doas', 'ssh', 'watch', 'xargs', 'parallel', 'flock', 'script', 'env', 'nohup', 'timeout', 'nice', 'command', 'builtin', 'time', 'setsid', 'stdbuf']);

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
  /** Names given to a function or an alias, and the names of commands that are fed. */
  functions: Set<string>;
  fed: Set<string>;
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
      const w = { ...word, text: textOf(word.pieces), open: /[*?]|\[.*\]|\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word.specials) };
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
    while (this.char() !== "'") {
      if (this.char() === undefined) throw new Lost();
      add(this.p[this.i]!, false);
      this.i += 1;
    }
    this.i += 1;
  }

  /** A string in double quotes, its expansions read as such. */
  private double(add: (piece: Piece, unquoted: boolean) => void): void {
    this.nest(() => {
      this.i += 1;
      for (;;) {
        const c = this.char();
        const next = this.char(1);
        if (c === undefined) throw new Lost();
        if (c === '"') break;
        if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== '\n') add(this.p[this.i + 1]!, false);
          this.i += 2;
        } else if (c === '`') {
          this.backquote(true);
          add(expansion('command'), false);
        } else if (c === '$') {
          this.dollar(add, (made) => add(expansion(made), false), false);
        } else {
          add(this.p[this.i]!, false);
          this.i += 1;
        }
      }
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
      if (/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])$/.test(inside)) add({ char: `\${${inside}}`, at: -1, made: 'parameter', name: inside }, false);
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
    for (;;) {
      const c = this.char();
      if (c === undefined) throw new Lost();
      if (c === "'") break;
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
        } else if (c === '`') {
          this.backquote(false);
        } else if (c === '$') {
          this.dollar(() => {}, () => {}, true);
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
    while (k < words.length && words[k]!.plain && BEFORE_COMMAND.has(words[k]!.text)) k += 1;
    while (k < words.length && ASSIGNMENT.test(words[k]!.text)) this.assigns(words[k++]!);
    const first = words[k];
    if (first === undefined) return;
    if (first.open && /[{]/.test(first.text) && first.text !== '{') {
      // Braces may make the command's name of what shows as quoted text.
      throw new Lost();
    }
    const name = this.nameOf(first);
    if (name === undefined) {
      // A command whose name is not known here, which may be eval or a shell: its arguments read as eval would read them.
      command.kind = 'runs';
      this.handOff(words.slice(k + 1));
      return;
    }
    const rest = words.slice(k + 1);
    // A script the command may have written, run by its path (`./fix.sh`).
    if (first.text.includes('/')) this.runsFile(first);
    // What sets a variable to what this does not follow: read, for, mapfile, printf -v and the like.
    if (DECLARES.has(name)) for (const word of rest) if (ASSIGNMENT.test(word.text)) this.assigns(word);
    if (name === 'for' && rest[1]?.text === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest[0]?.text ?? '')) {
      // for NAME in WORDS: one of them, each plain text.
      const each = rest.slice(2);
      this.sets(rest[0]!.text, each.length > 0 && each.every((word) => !word.made && !word.open && PLAIN.test(word.text) && !RUNNERS.has(program(word)) && !SHELLS.has(program(word))) ? each[0]!.text : null);
    } else if (['read', 'for', 'select', 'mapfile', 'readarray', 'printf', 'getopts', 'declare', 'typeset', 'local', 'export', 'readonly', 'unset', 'let'].includes(name)) {
      for (const word of rest) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) this.sets(word.text, null);
    }
    // A coprocess reads what the command writes to it, from anywhere.
    if (name === 'coproc') this.shared.across.risky = true;
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
      case 'eval':
        command.kind = 'runs';
        this.handOff(rest);
        return;
      case 'trap': {
        command.kind = 'runs';
        const operands = rest[0]?.text === '--' ? rest.slice(1) : rest;
        if (operands.length >= 2 && operands[0]!.text !== '-') this.handOff([operands[0]!]);
        return;
      }
      case 'alias':
        // In zsh, and in bash where it expands them, an alias's value is read as part of the command it stands in.
        for (const word of rest) {
          const equals = word.pieces.findIndex((piece) => piece.char === '=');
          if (equals <= 0) continue;
          const value = word.pieces.slice(equals + 1);
          this.shared.across.functions.add(textOf(word.pieces.slice(0, equals)));
          this.handOff([{ ...word, pieces: value, text: textOf(value) }]);
        }
        return;
      case 'source':
      case '.': {
        command.kind = 'runs';
        const file = rest[0];
        if (file?.pieces.some((piece) => piece.made === 'command' || piece.made === 'process')) throw new Lost();
        if (file && ['/dev/stdin', '/dev/fd/0'].includes(file.text)) command.kind = 'shell';
        this.runsFile(file);
        return;
      }
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
      case 'sudo':
        // sudo -s or -i runs its command with the user's shell, escaped its own way.
        if (rest.some((word) => /^-[A-Za-z]*[si][A-Za-z]*$/.test(word.text) || word.text === '--shell' || word.text === '--login')) {
          const after = rest.findIndex((word) => /^-[A-Za-z]*[si][A-Za-z]*$/.test(word.text) || word.text === '--shell' || word.text === '--login');
          if (rest.slice(after + 1).some((word) => !word.text.startsWith('-'))) throw new Lost();
          command.kind = 'shell';
          return;
        }
        break;
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
        this.shell(command, words.slice(j + 1));
        return;
      }
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
      if (file !== undefined) files.set(file, null);
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
    const value = textOf(word.pieces.slice(equals + 1));
    // An element of an array, or what adds to the value: not known.
    this.sets(name, !word.made && !word.open && PLAIN.test(value) && equals === name.length ? value : null);
  }

  /** What the command sets a variable to; set to two things, it is not known which a script sees. */
  private sets(name: string, value: string | null): void {
    const values = this.shared.across.values;
    values.set(name, values.has(name) && values.get(name) !== value ? null : value);
  }

  /**
   * The name of the program a word runs, where this can tell: the last part of its path, or what
   * the command set the variable it expands to (`$PY` after `PY=/usr/bin/python3`). A variable the
   * command does not set is the user's own: a program, but for `$SHELL` and `$BASH`, which are shells.
   */
  private nameOf(word: Word): string | undefined {
    if (!word.made && !word.open) return program(word);
    const slash = word.pieces.map((piece) => piece.char).lastIndexOf('/');
    const tail = word.pieces.slice(slash + 1);
    if (slash >= 0 && !tail.some((piece) => piece.made) && !/[*?[]/.test(textOf(tail))) return textOf(tail);
    const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(word.text)?.[1] ?? (word.pieces.length === 1 ? word.pieces[0]!.name : undefined);
    if (variable === undefined) return undefined;
    if (variable === 'SHELL' || variable === 'BASH') return 'sh';
    const value = this.shared.across.values.get(variable);
    if (value === undefined) return '';
    const parts = value?.trim().split(/[ \t]+/).map((part) => part.split('/').pop()!);
    return parts === undefined || parts.some((part) => RUNNERS.has(part) || SHELLS.has(part)) ? undefined : parts[0];
  }

  /** A shell's options and what it runs: the script after `-c`, its input, or a file. */
  private shell(command: Command, args: Word[]): void {
    // Braces or a pattern may make `-c` and a script of what shows as one word.
    if (args.some((word) => word.open)) throw new Lost();
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
  const across: Across = { readsInput: false, risky: false, functions: new Set(), fed: new Set(), values: new Map(), files: new Map(), runs: new Set() };
  try {
    for (const dialect of ['modern', 'bash32'] as const) {
      const shared: Shared = { asked, found, scripts: [pieces], pipelines: [], dialect, depth: 0, across };
      for (let k = 0; k < shared.scripts.length; k += 1) {
        if (k >= MOST_SCRIPTS) return undefined;
        new Reader(shared.scripts[k]!, shared).script();
        for (const pipeline of shared.pipelines.splice(0)) judge(pipeline, shared);
        ranFiles(shared);
      }
    }
  } catch (error) {
    // Lost, or a command nested deeper than the stack goes.
    if (error instanceof Lost || error instanceof RangeError) return undefined;
    throw error;
  }
  // A shell reads its input, and something may hand it text of the command line this does not follow.
  if (across.readsInput && (across.risky || [...across.fed].some((name) => across.functions.has(name)))) return undefined;
  return found;
}

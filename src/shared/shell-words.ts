/**
 * Where a shell reads a command's characters as part of a word: outside quotes, outside the bodies
 * of heredocs and outside comments, in the command itself and in what it runs inside `$( )`,
 * `<( )`, backquotes, `$(( ))` and `${ }`; and in a script the command hands to a shell: the one
 * after `-c` of sh, bash, zsh, dash or ksh (or of su), what `eval` runs, and what a heredoc, a
 * here-string, `echo` or `printf` feeds a shell that reads its commands from its input
 * (`bash <<EOF`, `printf … | sh`). Not where text the shell expands is split into words later (the
 * output of an unquoted `$( )`, a variable): that is not the command's own text.
 *
 * It reads as bash, zsh and dash do, and as bash 3.2 (macOS's `/bin/bash` and `/bin/sh`) does too,
 * which finds where a `$( )` ends by its own rules (bash32End) and so may run what the others take
 * for a heredoc's body or a comment; a character in a word for either counts. Past a syntax error
 * (a quote never closed) nothing of that script runs, so nothing more of it is read. Where the
 * shells read a command differently still, or it holds what this does not follow (a `case` in a
 * `$( )`, a `(` where an argument would be, a `{` inside `${ }`, `$'…\'…'`, quotes inside
 * `$(( ))`), it says so (undefined): then every such character counts as in a word.
 */

/** A character of a script, and where it is in the text shown (-1: nowhere, as one an escape or an expansion stands for). */
type Piece = { char: string; at: number };

/** A word of a simple command, as the shell has it once quotes are gone. */
type Word = { text: string; pieces: Piece[] };

/** What a pipeline feeds its commands' input, and whether one of them is a shell that runs what it reads. */
type Pipeline = { fed: Piece[][]; runs: boolean };

/** A heredoc that waits for its body: the line that ends it, whether tabs before its lines go, and whether its body is expanded. */
type Heredoc = { end: string; tabs: boolean; quoted: boolean; pipeline: Pipeline };

/** How `$( )` is read: as bash 4 and later, zsh and dash read it, or as bash 3.2 does (bash32End). */
type Dialect = 'modern' | 'bash32';

/** The command holds what this does not follow, or what shells read differently. */
class Lost extends Error {}

/** A syntax error, such as a quote never closed: the shell runs nothing of the script from here. */
class Ends extends Error {}

/** Shells that take a script after `-c`, or read one from their input. `$SHELL` is the user's. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', '$SHELL', '$BASH']);

/** Reserved words after which a command's name may still come. */
const BEFORE_COMMAND = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time']);

/** A word that assigns, after which the command's name may still come; and one that opens an array, `name=(`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const ARRAY = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;

/** What `$'…'` makes of an escape. */
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v' };

/** A stand-in for what an expansion gives, unknown here: part of a word, and nothing to show. */
const EXPANDED: Piece = { char: '\u0000', at: -1 };

const blank = (char: string | undefined) => char === ' ' || char === '\t';
const breaks = (char: string | undefined) => char === undefined || ' \t\n;&|<>()'.includes(char);
const textOf = (pieces: readonly Piece[]) => pieces.map((piece) => piece.char).join('');

/** What every reader of one command shares: what to find, what was found, the scripts to read, the pipelines that may feed one. */
type Shared = { asked: (char: string) => boolean; found: Set<number>; scripts: Piece[][]; pipelines: Pipeline[]; dialect: Dialect };

class Reader {
  private i = 0;

  /** Reading the body of an unquoted heredoc, which bash 3.2 expands only when it runs. */
  private heredoc = false;

  constructor(private readonly p: readonly Piece[], private readonly shared: Shared) {}

  /** A whole script, to its end or to a syntax error. */
  script(): void {
    try {
      this.code(false);
    } catch (error) {
      if (!(error instanceof Ends)) throw error;
    }
  }

  /** Text that is no script but runs what is in `$( )`, `${ }` or backquotes: an unquoted heredoc's body. */
  heredocBody(): void {
    this.heredoc = true;
    try {
      this.expansions();
    } catch (error) {
      if (!(error instanceof Ends)) throw error;
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
    let word: Piece[] | undefined;
    let plain = true;
    let words: Word[] = [];
    let target = false;
    let herestring = false;
    let atCommand = true;
    let assigned = false;
    let depth = 0;
    let cases = 0;
    let pipeline: Pipeline = { fed: [], runs: false };
    let fed: Piece[][] = [];
    const pending: Heredoc[] = [];

    const add = (piece: Piece, unquoted: boolean) => {
      if (unquoted) this.flag(piece);
      else plain = false;
      (word ??= []).push(piece);
    };
    const expanded = () => add(EXPANDED, false);
    const endWord = () => {
      if (word === undefined) return;
      const text = textOf(word);
      if (herestring) fed.push(word);
      else if (!target) {
        // A case's patterns end in a `)` that opens nothing: in a `$( )`, past what this follows.
        if (plain && (text === 'case' || text === 'esac')) {
          if (closes) throw new Lost();
          if (text === 'case' && atCommand && !assigned) cases += 1;
          else if (text === 'esac' && cases > 0) cases -= 1;
        }
        words.push({ text, pieces: word });
        if (atCommand && !(plain && BEFORE_COMMAND.has(text))) {
          if (ASSIGNMENT.test(text)) assigned = true;
          else atCommand = false;
        }
      }
      herestring = false;
      target = false;
      word = undefined;
      plain = true;
    };
    const endCommand = () => {
      endWord();
      this.hands(words, pipeline);
      pipeline.fed.push(...fed);
      words = [];
      fed = [];
      atCommand = true;
      assigned = false;
    };
    const endPipeline = () => {
      endCommand();
      this.shared.pipelines.push(pipeline);
      pipeline = { fed: [], runs: false };
    };

    for (;;) {
      const c = this.char();
      const next = this.char(1);
      if (c === undefined) {
        // A `$(` never closed is a syntax error; a heredoc whose line never came ends with the text.
        if (closes) throw new Ends();
        endPipeline();
        return this.i;
      }
      if (blank(c)) {
        endWord();
        this.i += 1;
      } else if (c === '\n') {
        endPipeline();
        this.i += 1;
        this.bodies(pending);
      } else if (c === '#' && word === undefined) {
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
        word ??= [];
        plain = false;
        this.single(add);
      } else if (c === '"') {
        word ??= [];
        plain = false;
        this.double(add);
      } else if (c === '`') {
        this.backquote(false);
        expanded();
      } else if (c === '$') {
        if (next === "'" || next === '"') {
          word ??= [];
          plain = false;
        }
        this.dollar(add, expanded, true);
      } else if (c === ';') {
        endPipeline();
        this.i += next === ';' || next === '&' ? 2 : 1;
      } else if (c === '&') {
        if (next === '>') {
          endWord();
          this.i += this.char(2) === '>' ? 3 : 2;
          target = true;
        } else {
          endPipeline();
          this.i += next === '&' ? 2 : 1;
        }
      } else if (c === '|') {
        if (next === '|') endPipeline();
        else endCommand();
        this.i += next === '|' || next === '&' ? 2 : 1;
      } else if (c === '<' || c === '>') {
        // A descriptor's number (or {name}) right before belongs to the redirection.
        if (word !== undefined && plain && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(textOf(word))) word = undefined;
        endWord();
        if (c === '<' && next === '<' && this.char(2) === '<') {
          this.i += 3;
          herestring = true;
        } else if (c === '<' && next === '<') {
          this.i += 2;
          const tabs = this.char() === '-';
          if (tabs) this.i += 1;
          pending.push({ ...this.delimiter(), tabs, pipeline });
        } else if (next === '(') {
          this.i += 2;
          this.substitution();
          expanded();
        } else {
          this.i += 1;
          if (this.char() === '>' || this.char() === '|' || this.char() === '&' || (c === '<' && this.char() === '>')) this.i += 1;
          target = true;
        }
      } else if (c === '(') {
        if (word !== undefined) {
          if (plain && ARRAY.test(textOf(word))) {
            // An array: its elements are words, comments allowed.
            endWord();
            depth += 1;
            this.i += 1;
          } else if (next === ')') {
            // A function's name: its body comes where a command would.
            endWord();
            this.i += 2;
            atCommand = true;
          } else {
            // A `(` in a word: a glob in zsh, an error in bash.
            throw new Lost();
          }
        } else if (next === '(' && (atCommand || (words.length === 1 && words[0]!.text === 'for'))) {
          // (( … )), and for (( … )).
          this.i += 2;
          this.arithmetic();
          expanded();
          endWord();
        } else if (atCommand && !assigned) {
          endCommand();
          depth += 1;
          this.i += 1;
        } else {
          // Where an argument would be: a glob in zsh, an error in bash.
          throw new Lost();
        }
      } else if (c === ')') {
        endWord();
        if (depth > 0) {
          endCommand();
          depth -= 1;
          atCommand = false;
          this.i += 1;
        } else if (closes) {
          endPipeline();
          // A heredoc asked for on the line a `$( )` ends: bash 5 reads its body after it, others do not.
          if (pending.length > 0) throw new Lost();
          this.i += 1;
          return this.i - 1;
        } else if (cases > 0) {
          // The end of a case's pattern: its commands follow.
          endCommand();
          this.i += 1;
        } else {
          throw new Ends();
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
      if (this.char() === undefined) throw new Ends();
      add(this.p[this.i]!, false);
      this.i += 1;
    }
    this.i += 1;
  }

  /** A string in double quotes, its expansions read as such. */
  private double(add: (piece: Piece, unquoted: boolean) => void): void {
    this.i += 1;
    for (;;) {
      const c = this.char();
      const next = this.char(1);
      if (c === undefined) throw new Ends();
      if (c === '"') break;
      if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') add(this.p[this.i + 1]!, false);
        this.i += 2;
      } else if (c === '`') {
        this.backquote(true);
        add(EXPANDED, false);
      } else if (c === '$') {
        this.dollar(add, () => add(EXPANDED, false), false);
      } else {
        add(this.p[this.i]!, false);
        this.i += 1;
      }
    }
    this.i += 1;
  }

  /** What follows a `$`: a quote, a substitution, an expansion, or the `$` of a parameter. */
  private dollar(add: (piece: Piece, unquoted: boolean) => void, expanded: () => void, unquoted: boolean): void {
    const next = this.char(1);
    if (unquoted && next === "'") {
      this.ansi(add);
    } else if (unquoted && next === '"') {
      this.i += 1;
      this.double(add);
    } else if (next === '(' && this.char(2) === '(') {
      this.i += 3;
      this.arithmetic();
      expanded();
    } else if (next === '(') {
      this.i += 2;
      this.substitution(this.heredoc ? 'expanded' : unquoted ? 'read' : 'quoted');
      expanded();
    } else if (next === '{') {
      this.i += 2;
      this.braces(unquoted);
      expanded();
    } else if (next === '[') {
      // $[ … ], arithmetic of old: past what this follows.
      throw new Lost();
    } else {
      add(this.p[this.i]!, unquoted);
      this.i += 1;
    }
  }

  /** A string in `$'…'`, its escapes made what they stand for. */
  private ansi(add: (piece: Piece, unquoted: boolean) => void): void {
    this.i += 2;
    for (;;) {
      const c = this.char();
      if (c === undefined) throw new Ends();
      if (c === "'") break;
      if (c !== '\\') {
        add(this.p[this.i]!, false);
        this.i += 1;
        continue;
      }
      const e = this.char(1);
      if (e === undefined) throw new Ends();
      // dash has no $'…': there the string ends at this quote.
      if (e === "'") throw new Lost();
      const code = /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|c[\s\S])/.exec(textOf(this.p.slice(this.i + 1, this.i + 10)));
      add({ char: ESCAPES[e] ?? (code ? '\u0001' : e), at: -1 }, false);
      this.i += 1 + (code ? code[0].length : 1);
    }
    this.i += 1;
  }

  /**
   * `$( )`, `<( )` or `>( )`: commands. bash 3.2 first finds where it ends (bash32End: as it reads
   * the command, in double quotes or not, or as it expands a heredoc's body), then reads what is
   * between as a script of its own.
   */
  private substitution(comments: Comments = 'read'): void {
    if (this.shared.dialect === 'modern') {
      this.code(true);
      return;
    }
    const start = this.i;
    const end = bash32End(this.p, start, comments);
    new Reader(this.p.slice(start, end), this.shared).script();
    this.i = end + 1;
  }

  /** `$(( ))` or `(( ))`: arithmetic, where `<<` shifts and `#` starts no comment. */
  private arithmetic(): void {
    let depth = 0;
    for (;;) {
      const c = this.char();
      if (c === undefined) throw new Ends();
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
  }

  /** `${ }`: a parameter, and the words of what it expands to, in double quotes or not. */
  private braces(unquoted: boolean): void {
    for (;;) {
      const c = this.char();
      if (c === undefined) throw new Ends();
      if (c === '}') {
        this.i += 1;
        return;
      }
      // bash and dash end it at the first `}`, zsh at the one that pairs with this `{`.
      if (c === '{') throw new Lost();
      if (c === '\\') {
        if (this.char(1) === undefined) throw new Ends();
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
        if (unquoted) this.flag(this.p[this.i]);
        this.i += 1;
      }
    }
  }

  /** Backquotes: their text, its escapes undone, is a script. */
  private backquote(inDouble: boolean): void {
    this.i += 1;
    const inner: Piece[] = [];
    for (;;) {
      const c = this.char();
      const next = this.char(1);
      if (c === undefined) throw new Ends();
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
    new Reader(inner, this.shared).script();
  }

  /**
   * The word after `<<`: the line that ends the heredoc, and whether any of it is quoted (its body is
   * then as it is). Quoted or not, each of its characters decides where the heredoc ends.
   */
  private delimiter(): { end: string; quoted: boolean } {
    while (blank(this.char())) this.i += 1;
    let end = '';
    let quoted = false;
    const start = this.i;
    for (;;) {
      const c = this.char();
      if (breaks(c)) break;
      if (c === "'" || c === '"') {
        quoted = true;
        this.i += 1;
        while (this.char() !== c) {
          const d = this.char();
          if (d === undefined) throw new Ends();
          if (c === '"' && (d === '$' || d === '`')) throw new Lost();
          if (c === '"' && d === '\\' && this.char(1) !== undefined && '$`"\\'.includes(this.char(1)!)) this.i += 1;
          this.flag(this.p[this.i]);
          end += this.char()!;
          this.i += 1;
        }
        this.i += 1;
      } else if (c === '\\') {
        quoted = true;
        if (this.char(1) === undefined) throw new Ends();
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
    // `<<` with no word: a syntax error.
    if (this.i === start) throw new Ends();
    return { end, quoted };
  }

  /** Heredoc bodies, from the line after the one that asked for them, each to its line or to the end. */
  private bodies(pending: Heredoc[]): void {
    for (const heredoc of pending.splice(0)) {
      const body: Piece[] = [];
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
          break;
        }
        body.push(...line);
      }
      heredoc.pipeline.fed.push(body);
      // An unquoted heredoc's body is expanded: what runs in it is a script.
      if (!heredoc.quoted) new Reader(body, this.shared).heredocBody();
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

  /**
   * What a command hands to a shell: the script after a shell's `-c` (or su's), what `eval` runs;
   * and, where it is a shell that reads its commands from its input, that its pipeline's input is a
   * script. What `echo` and `printf` write is their pipeline's input too.
   */
  private hands(words: Word[], pipeline: Pipeline): void {
    const named = words.findIndex((word) => !ASSIGNMENT.test(word.text));
    if (named >= 0 && ['echo', 'printf'].includes(words[named]!.text)) pipeline.fed.push(...words.slice(named + 1).map((word) => word.pieces));
    for (let k = 0; k < words.length; k += 1) {
      const name = words[k]!.text.split('/').pop()!;
      if (name === 'eval') {
        const script: Piece[] = [];
        for (const word of words.slice(k + 1)) script.push(...(script.length > 0 ? [{ char: ' ', at: -1 }] : []), ...word.pieces);
        this.shared.scripts.push(script);
        return;
      }
      if (name === 'su') {
        for (let m = k + 1; m < words.length; m += 1) {
          const option = words[m]!.text;
          if ((/^-[A-Za-z]*c$/.test(option) || option === '--command') && words[m + 1]) this.shared.scripts.push(words[m + 1]!.pieces);
          else if (option.startsWith('--command=')) this.shared.scripts.push(words[m]!.pieces.slice('--command='.length));
        }
        return;
      }
      if (!SHELLS.has(name)) continue;
      let script = false;
      let input = false;
      let m = k + 1;
      for (; m < words.length; m += 1) {
        const option = words[m]!.text;
        if (option === '-' || option === '--') {
          m += 1;
          break;
        }
        if (option.startsWith('--')) {
          if (option === '--rcfile' || option === '--init-file') m += 1;
          continue;
        }
        if (!/^[-+][A-Za-z]+$/.test(option)) break;
        if (option.startsWith('-') && option.includes('c')) script = true;
        if (option.startsWith('-') && option.includes('s')) input = true;
        if (/[oO]$/.test(option)) m += 1;
      }
      if (script) {
        if (words[m]) this.shared.scripts.push(words[m]!.pieces);
      } else if (m >= words.length || input) {
        pipeline.runs = true;
      }
      return;
    }
  }
}

/**
 * Where a `#` starts a comment as bash 3.2 finds where a `$(`, `<(` or `>(` ends: when it reads the
 * command, after a space, a tab or a newline, or first in it, but never in double quotes (parse.y);
 * when it expands a heredoc's body, after a space, a tab or a newline (subst.c).
 */
type Comments = 'read' | 'quoted' | 'expanded';

/**
 * Where bash 3.2 (macOS's /bin/bash and /bin/sh) ends a `$(`, `<(` or `>(` whose text starts at
 * `at`: the index of its `)`. It counts parentheses, skips what is quoted or escaped and a comment
 * (Comments), and takes no notice of a heredoc, a case or `${ }`. Never closed: a syntax error.
 */
function bash32End(p: readonly Piece[], at: number, comments: Comments): number {
  let i = at;
  const char = (k: number) => p[k]?.char;
  /** From after an opening quote or backquote to after its close: with `escapes`, a backslash takes the next character. */
  const quoted = (close: string, escapes: boolean) => {
    for (;;) {
      const c = char(i);
      if (c === undefined) throw new Ends();
      i += 1;
      if (c === close) return;
      if (c === '\\' && escapes) i += 1;
      else if (close === '"' && c === '`') quoted('`', true);
      else if (close === '"' && c === '$' && char(i) === '(') i = bash32End(p, i + 1, comments === 'expanded' ? 'expanded' : 'quoted') + 1;
      else if (close === '"' && c === '$' && char(i) === '{') {
        i += 1;
        braced();
      }
    }
  };
  /** `${…}` in double quotes: to its first `}`, quotes skipped. */
  const braced = () => {
    for (;;) {
      const c = char(i);
      if (c === undefined) throw new Ends();
      i += 1;
      if (c === '}') return;
      if (c === '\\') i += 1;
      else if (c === "'" || c === '"' || c === '`') quoted(c, c !== "'");
    }
  };
  let depth = 1;
  let comment = false;
  // What came before: the character bash 3.2 read last (a backslash and a newline are gone).
  let before: string | undefined;
  for (;;) {
    const c = char(i);
    if (c === undefined) throw new Ends();
    const after = comments === 'expanded' ? char(i - 1) : before;
    if (comment) {
      if (c === '\n') comment = false;
    } else if (c === '#' && comments !== 'quoted' && ((comments === 'read' && i === at) || after === ' ' || after === '\t' || after === '\n')) {
      comment = true;
    } else if (c === '\\') {
      i += 1;
      if (char(i) === undefined) throw new Ends();
      if (char(i) === '\n') {
        i += 1;
        continue;
      }
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (c === '(') {
      depth += 1;
    } else if (c === "'" || c === '"' || c === '`') {
      const dollar = before === '$';
      i += 1;
      quoted(c, c !== "'" || dollar);
      i -= 1;
    }
    before = char(i);
    i += 1;
  }
}

/** At most this many scripts in one command, those it hands to a shell included; past them, all counts as in a word. */
const MOST_SCRIPTS = 64;

/**
 * Where, of the characters `asked` matches, a shell reads one as part of a word in `command` (their
 * offsets); undefined where shells read the command differently or it holds what this does not follow.
 */
export function inWords(command: string, asked: (char: string) => boolean): Set<number> | undefined {
  const found = new Set<number>();
  const pieces = [...command.matchAll(/[\s\S]/gu)].map((match) => ({ char: match[0], at: match.index }));
  try {
    for (const dialect of ['modern', 'bash32'] as const) {
      const shared: Shared = { asked, found, scripts: [pieces], pipelines: [], dialect };
      for (let k = 0; k < shared.scripts.length; k += 1) {
        if (k >= MOST_SCRIPTS) return undefined;
        new Reader(shared.scripts[k]!, shared).script();
        // A pipeline that feeds a shell feeds it a script.
        for (const pipeline of shared.pipelines.splice(0)) if (pipeline.runs) shared.scripts.push(...pipeline.fed);
      }
    }
  } catch (error) {
    if (error instanceof Lost) return undefined;
    throw error;
  }
  return found;
}

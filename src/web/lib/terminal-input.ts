/**
 * What the terminal's keys send, and what its screen says, for the Terminal tab
 * (components/WorkspaceTerminal): the phone's key row and line field, and the screen as text.
 */

import { type TerminalColors, terminalColors } from '../../shared/terminal';

/** The keys of the phone's key row that a phone's keyboard lacks, as a terminal sends them. */
export type RowKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

const ARROWS: Record<'up' | 'down' | 'right' | 'left', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * A key as a terminal sends it: the arrows as the program asked for them (vim and less ask for
 * application cursor keys), and with Ctrl held, as xterm sends Ctrl and an arrow.
 */
export function keySequence(key: RowKey, { applicationCursor = false, ctrl = false }: { applicationCursor?: boolean; ctrl?: boolean } = {}): string {
  if (key === 'esc') return '\x1b';
  if (key === 'tab') return '\t';
  const letter = ARROWS[key];
  if (ctrl) return `\x1b[1;5${letter}`;
  return applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
}

/**
 * Ctrl and a character, as a terminal sends it: Ctrl+C is ETX (3), Ctrl+[ is Esc, Ctrl+Space is
 * NUL. Undefined for a character Ctrl does nothing with.
 */
export function controlCharacter(char: string): string | undefined {
  if (char.length !== 1) return undefined;
  const code = char.toUpperCase().charCodeAt(0);
  // @, A to Z, [, \, ], ^ and _ are 64 to 95: Ctrl takes 64 off.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  const digits: Record<string, string> = { ' ': '\x00', '2': '\x00', '3': '\x1b', '4': '\x1c', '5': '\x1d', '6': '\x1e', '7': '\x1f', '/': '\x1f', '-': '\x1f', '8': '\x7f', '?': '\x7f' };
  return digits[char];
}

/**
 * A line that asks for a password or a passphrase, as sudo, ssh, git and gpg ask, in the
 * languages a system says it in: the line field hides what is typed while the cursor sits after
 * one. The words have to end there, in a colon, as a prompt does.
 */
const SECRET = /(?:(?:^|[^\p{L}\p{N}])(?:pass(?:word|phrase|code)s?|pin|passwort|mot de passe|contraseña|senha|пароль)(?!\p{L})|密码|口令|パスワード|암호|비밀번호).*[:：]\s*$/iu;

export const asksForSecret = (line: string): boolean => SECRET.test(line);

/** The part of xterm's buffer the screen is read through (IBuffer). */
export type BufferLike = {
  readonly length: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined;
};

/**
 * The screen and its scrollback as text (rows `from` up to `to`): a line the terminal wrapped is
 * one line again, and the empty rows above the first line and under the last are left out.
 */
export function bufferText(buffer: BufferLike, from = 0, to = buffer.length): string {
  const lines: string[] = [];
  for (let y = Math.max(0, from); y < Math.min(to, buffer.length); y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // A row that goes on in the next keeps its spaces at the end: they are inside the line.
    const goesOn = buffer.getLine(y + 1)?.isWrapped ?? false;
    const text = line.translateToString(!goesOn);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  return lines.join('\n');
}

/** The rows on screen now, as text, as bufferText reads them. */
export const viewportText = (buffer: BufferLike, rows: number): string => bufferText(buffer, buffer.viewportY, buffer.viewportY + rows);

/** What the cursor's row says before the cursor: a prompt, when a program waits for a line. */
export function lineBeforeCursor(buffer: BufferLike): string {
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true, 0, buffer.cursorX) ?? '';
}

/** The 16 colors of an xterm.js theme, in the order programs number them. */
const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

/** The colors a theme draws in, as the server answers a program that asks for one; none unless each is `#rrggbb`. */
export function themeColors(theme: Partial<Record<'foreground' | 'background' | 'cursor' | (typeof ANSI_NAMES)[number], string>> | undefined): TerminalColors | undefined {
  if (!theme) return undefined;
  return terminalColors({ foreground: theme.foreground, background: theme.background, cursor: theme.cursor, ansi: ANSI_NAMES.map((name) => theme[name]) });
}

/**
 * A color sequence a program sent (OSC 4, 10, 11 or 12; `data` is what follows the number): whether
 * it asks for a color, which is the server's to answer, and, where it also sets some, the
 * sequence that sets those alone, for the page to draw. One that only sets colors is the page's.
 */
export function colorQuery(ident: number, data: string): { asks: boolean; sets?: string } {
  const slots = data.split(';');
  const sets: string[] = [];
  let asks = false;
  if (ident === 4) {
    for (let at = 0; at + 1 < slots.length; at += 2) {
      if (slots[at + 1] === '?') asks = true;
      else sets.push(`${slots[at]};${slots[at + 1]}`);
    }
    return asks ? { asks, ...(sets.length > 0 ? { sets: `\x1b]4;${sets.join(';')}\x1b\\` } : {}) } : { asks };
  }
  // 10, 11 and 12 each go on to the next with every `;`: text, background, cursor.
  slots.forEach((slot, at) => {
    if (ident + at > 12) return;
    if (slot === '?') asks = true;
    else sets.push(`\x1b]${ident + at};${slot}\x1b\\`);
  });
  return asks ? { asks, ...(sets.length > 0 ? { sets: sets.join('') } : {}) } : { asks };
}

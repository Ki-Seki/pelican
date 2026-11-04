import { qrModules } from '../shared/qr.js';

/** A QR code for a terminal: two rows per line, drawn in black and white whatever the theme. */
export function qrTerminal(text: string): string {
  const rows = qrModules(text);
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = '';
    for (let x = 0; x < rows[y]!.length; x += 1) {
      const top = rows[y]![x] ? 16 : 231;
      const bottom = rows[y + 1]?.[x] ? 16 : 231;
      line += `\x1b[38;5;${top};48;5;${bottom}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}

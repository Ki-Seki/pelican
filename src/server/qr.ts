import qrcode from 'qrcode-generator';

const QUIET = 2;

function modules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let y = -QUIET; y < size + QUIET; y += 1) {
    const row: boolean[] = [];
    for (let x = -QUIET; x < size + QUIET; x += 1) row.push(x >= 0 && y >= 0 && x < size && y < size && qr.isDark(y, x));
    rows.push(row);
  }
  return rows;
}

/** A QR code for a terminal: two rows per line, drawn in black and white whatever the theme. */
export function qrTerminal(text: string): string {
  const rows = modules(text);
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

/** The same code as an SVG, for the page. */
export function qrSvg(text: string): string {
  const rows = modules(text);
  const size = rows.length;
  let path = '';
  rows.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x} ${y}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

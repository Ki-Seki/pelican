import qrcode from 'qrcode-generator';

const QUIET = 2;

/** The dark and light modules of a QR code for `text`, with a quiet border. */
export function qrModules(text: string): boolean[][] {
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

/** The same code as an SVG, black on white whatever the theme. */
export function qrSvg(text: string): string {
  const rows = qrModules(text);
  const size = rows.length;
  let path = '';
  rows.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x} ${y}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/**
 * What a diff that holds no lines says, in words. Git writes only its header for a file renamed or
 * copied whole, one whose mode alone changed, and an empty file added or deleted; the header itself
 * (`similarity index 100%`, `rename from …`) is git's, not something to read.
 */
export function headerOnly(diff: string): string | undefined {
  const field = (name: string) => {
    const value = new RegExp(`^${name} (.+)$`, 'm').exec(diff)?.[1];
    return value === undefined ? undefined : unquoted(value);
  };
  const renamed = field('rename from');
  const copied = renamed === undefined ? field('copy from') : undefined;
  const mode = modeChange(field('old mode'), field('new mode'));
  if (renamed !== undefined || copied !== undefined) {
    const moved = renamed !== undefined ? `Renamed from ${renamed}` : `Copied from ${copied}`;
    return mode ? `${moved}, and ${mode}` : `${moved}, unchanged`;
  }
  if (mode) return `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
  if (/^new file mode /m.test(diff)) return 'A new, empty file';
  if (/^deleted file mode /m.test(diff)) return 'An empty file, deleted';
  return undefined;
}

function modeChange(before: string | undefined, after: string | undefined): string | undefined {
  if (!before || !after || before === after) return undefined;
  if (before === '100644' && after === '100755') return 'made executable';
  if (before === '100755' && after === '100644') return 'no longer executable';
  return `its mode changed from ${before} to ${after}`;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git quotes one with unusual characters in it (`"tab\there.txt"`), as it is. */
function unquoted(name: string): string {
  if (name.length < 2 || !name.startsWith('"') || !name.endsWith('"')) return name;
  const body = name.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') {
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4))?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += 4;
        continue;
      }
      const code = ESCAPES[body[i + 1] ?? ''];
      if (code !== undefined) {
        bytes.push(code);
        i += 2;
        continue;
      }
    }
    const char = String.fromCodePoint(body.codePointAt(i)!);
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

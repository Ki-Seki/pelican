// The Claude Code the tests run: the copy the Agent SDK's package for this platform brings, as npm
// installed it beside the SDK, a devDependency; found the way the SDK finds it. Pelican itself runs
// the user's own (src/server/claude-code.ts), and fetches the SDK without these packages.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function testClaude(): string | undefined {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      const file = require.resolve(`${name}/claude${exe}`);
      if (existsSync(file)) return file;
    } catch {
      // Not installed for this platform; the next.
    }
  }
  return undefined;
}

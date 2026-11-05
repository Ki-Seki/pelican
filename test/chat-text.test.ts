import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolResultBlock } from '../src/shared/protocol';
import { describeTool } from '../src/web/lib/tools';
import { buildItems, cleanOutput } from '../src/web/lib/turns';

const ESC = '\u001b';

describe('cleanOutput', () => {
  it('takes out colors and other escape codes, keeping a link’s text', () => {
    expect(cleanOutput(`${ESC}[1m${ESC}[32m✓${ESC}[39m${ESC}[22m test/app.test.ts ${ESC}[2m(12 tests)${ESC}[22m`)).toBe('✓ test/app.test.ts (12 tests)');
    expect(cleanOutput(`${ESC}[38;5;208morange${ESC}[0m and ${ESC}[38;2;255;0;0mred${ESC}[0m`)).toBe('orange and red');
    expect(cleanOutput(`${ESC}]8;;https://example.com${ESC}\\link text${ESC}]8;;${ESC}\\ after`)).toBe('link text after');
    expect(cleanOutput(`${ESC}]0;title\u0007done`)).toBe('done');
    expect(cleanOutput(`${ESC}(B${ESC}7saved${ESC}8`)).toBe('saved');
  });

  it('shows a line rewritten with \\r as it ended, and Windows line ends as lines', () => {
    expect(cleanOutput('Downloading [=>  ] 50%\rDownloading [===] 100%\nnext')).toBe('Downloading [===] 100%\nnext');
    expect(cleanOutput(`${ESC}[2K${ESC}[1Gprogress\rdone\r`)).toBe('done');
    expect(cleanOutput('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('drops control characters but keeps tabs and line breaks', () => {
    expect(cleanOutput('a\u0007b\u0000c\td\ne\u007f')).toBe('abc\td\ne');
  });

  it('unwraps Claude Code’s error tags, and only when they wrap the whole text', () => {
    expect(cleanOutput('<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>')).toBe('String to replace not found in file.\nString: foo');
    expect(cleanOutput('grep found "<tool_use_error>" in log.txt')).toBe('grep found "<tool_use_error>" in log.txt');
  });

  it('cleans the output of local commands shown in the conversation', () => {
    const items = buildItems([{ uuid: 'o', role: 'user', blocks: [{ type: 'text', text: `<local-command-stdout>${ESC}[1mContext Usage${ESC}[22m\n62k/200k tokens</local-command-stdout>` }] }]);
    expect(items).toMatchObject([{ kind: 'notice', tone: 'output', text: 'Context Usage\n62k/200k tokens' }]);
  });
});


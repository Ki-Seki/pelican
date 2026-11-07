import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolResultBlock } from '../src/shared/protocol';
import { describeTool } from '../src/web/lib/tools';
import { answersOf, buildItems, cleanOutput, outcomeOf, splitFiles, type ToolCall, withFiles } from '../src/web/lib/turns';

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

describe('files sent with a prompt', () => {
  const block = 'Attached files:\n- /home/me/.local/state/pelican/uploads/5f1e2d3c-4b5a-4968-8776-655443322110/report (1).pdf (report (1).pdf)\n- /tmp/notes.txt (notes.txt)';

  it('are names to show, not the paths Claude reads them from', () => {
    expect(splitFiles(`Why is it slow?\n\n${block}`)).toEqual({
      text: 'Why is it slow?',
      files: [
        { name: 'report (1).pdf', id: '5f1e2d3c-4b5a-4968-8776-655443322110', path: '/home/me/.local/state/pelican/uploads/5f1e2d3c-4b5a-4968-8776-655443322110/report (1).pdf' },
        { name: 'notes.txt', path: '/tmp/notes.txt' },
      ],
    });
    expect(splitFiles(block).text).toBe('');
    expect(splitFiles('Attached files: none, I forgot').files).toEqual([]);
  });

  it('come back as the same block when the prompt is sent again', () => {
    const { text, files } = splitFiles(`Why is it slow?\n\n${block}`);
    expect(withFiles(`${text} Look again.`, files)).toBe(`Why is it slow? Look again.\n\n${block}`);
    expect(withFiles('Only text', [])).toBe('Only text');
  });

  it('are named on lines of their own while the prompt is on its way', () => {
    expect(splitFiles('Read these\n📎 a.pdf\n📎 b.csv', true)).toEqual({ text: 'Read these', files: [{ name: 'a.pdf' }, { name: 'b.csv' }] });
    // Typed text is left as it is once the prompt is written down.
    expect(splitFiles('Read these\n📎 a.pdf').files).toEqual([]);
  });

  it('show with the prompt in the conversation', () => {
    const items = buildItems([{ uuid: 'u', role: 'user', blocks: [{ type: 'text', text: `Why?\n\n${block}` }] }]);
    expect(items).toMatchObject([{ kind: 'user', text: 'Why?', files: [{ name: 'report (1).pdf' }, { name: 'notes.txt' }] }]);
  });
});

const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const call = (name: string, content: string, extra: Partial<ToolResultBlock> = {}): ToolCall => ({
  id: 't', name, input: {}, result: { type: 'tool_result', tool_use_id: 't', content, is_error: true, ...extra },
});

describe('outcomeOf', () => {
  it('tells a call that ran from one still waiting', () => {
    expect(outcomeOf({ id: 't', name: 'Bash', input: {} })).toEqual({ kind: 'pending' });
    expect(outcomeOf({ id: 't', name: 'Bash', input: {}, result: { type: 'tool_result', tool_use_id: 't', content: 'ok' } })).toEqual({ kind: 'done' });
    expect(outcomeOf(call('Bash', 'Exit code 1\nnpm ERR!'))).toEqual({ kind: 'failed' });
    expect(outcomeOf(call('Edit', '<tool_use_error>String to replace not found in file.</tool_use_error>'))).toEqual({ kind: 'failed' });
  });

  it('knows Claude Code’s refusals, with the user’s words when there are some', () => {
    expect(outcomeOf(call('Bash', `${REJECT} To tell you how to proceed, the user said:\nNever remove volumes.`))).toEqual({ kind: 'denied', note: 'Never remove volumes.' });
    expect(outcomeOf(call('Edit', `${REJECT} STOP what you are doing and wait for the user to tell you how to proceed.`))).toEqual({ kind: 'denied' });
    expect(outcomeOf(call('Bash', 'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\nnot this one'))).toEqual({ kind: 'denied', note: 'not this one' });
    expect(outcomeOf(call('ExitPlanMode', 'The agent proposed a plan that was rejected by the user. The user chose to stay in plan mode rather than proceed with implementation.\n\nRejected plan:\n## Plan'))).toEqual({ kind: 'denied' });
  });

  it('knows Pelican’s own refusals: its fixed words, a note the transcript marks, a plan or question turned down', () => {
    expect(outcomeOf(call('Bash', 'The user declined this.'))).toEqual({ kind: 'denied' });
    expect(outcomeOf(call('Write', 'Put it in .env.local instead.', { denied: true }))).toEqual({ kind: 'denied', note: 'Put it in .env.local instead.' });
    expect(outcomeOf(call('ExitPlanMode', 'Keep the old tables for a week.'))).toEqual({ kind: 'denied', note: 'Keep the old tables for a week.' });
    expect(outcomeOf(call('AskUserQuestion', 'The user chose not to answer.'))).toEqual({ kind: 'denied' });
    expect(outcomeOf(call('ExitPlanMode', '<tool_use_error>Not in plan mode</tool_use_error>'))).toEqual({ kind: 'failed' });
  });

  it('tells a call cut short from one refused', () => {
    for (const text of [
      '[Request interrupted by user for tool use]',
      `${REJECT} STOP what you are doing and wait for the user to tell you how to proceed. Correction to the text above: this call was stopped while running, not refused before it ran.`,
      "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
      '[Tool call did not complete: the turn was ended to deliver the message that follows.]',
      'Interrupted by the user.',
      'Session closed.',
    ]) expect(outcomeOf(call('Bash', text)), text).toEqual({ kind: 'stopped' });
  });
});

describe('answersOf', () => {
  const asked = ['Which database should the service use?', 'Which environments need it?'];

  it('reads each answer and note, in Claude Code’s words of today and before', () => {
    expect(answersOf(asked, 'Your questions have been answered: "Which database should the service use?"="Postgres", "Which environments need it?"="dev, staging" notes: not production yet. You can now continue with these answers in mind.')).toEqual({
      'Which database should the service use?': { answer: 'Postgres' },
      'Which environments need it?': { answer: 'dev, staging', notes: 'not production yet' },
    });
    expect(answersOf(asked, 'User has answered your questions: "Which database should the service use?"="SQLite", "Which environments need it?"="dev". You can now continue with the user\'s answers in mind.')).toEqual({
      'Which database should the service use?': { answer: 'SQLite' },
      'Which environments need it?': { answer: 'dev' },
    });
  });

  it('keeps quotes and commas inside an answer, and a question left without one', () => {
    expect(answersOf(asked, 'The user answered: "Which database should the service use?"="the "fast" one, please", "Which environments need it?"=(no option selected) notes: ask Sam. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.')).toEqual({
      'Which database should the service use?': { answer: 'the "fast" one, please' },
      'Which environments need it?': { notes: 'ask Sam' },
    });
  });

  it('leaves out a preview and questions the text does not answer', () => {
    expect(answersOf(asked, 'Your questions have been answered: "Which database should the service use?"="Postgres" selected preview:\n<pre>db: postgres</pre>. You can now continue with these answers in mind.')).toEqual({
      'Which database should the service use?': { answer: 'Postgres' },
    });
    expect(answersOf(asked, 'The user did not answer the questions.')).toEqual({});
  });
});

describe('task lists in the conversation', () => {
  const todo = (id: string, states: string[], names = ['Read', 'Write', 'Test']): ChatMessage => ({
    uuid: `a-${id}`, role: 'assistant',
    blocks: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: names.map((content, i) => ({ content, status: states[i], activeForm: `${content}ing` })) } }],
  });
  const steps = (messages: ChatMessage[]) => {
    const turn = buildItems(messages).find((i) => i.kind === 'assistant');
    return turn?.kind === 'assistant' ? turn.parts.map((p) => (p.kind === 'tool' ? describeTool(p.call.name, p.call.input).target : undefined)) : [];
  };

  it('are each one step line, new, changed or finished alike: the bar above the box is the list’s live view', () => {
    expect(steps([
      todo('1', ['in_progress', 'pending', 'pending']),
      todo('2', ['completed', 'in_progress', 'pending']),
      todo('3', ['completed', 'in_progress', 'pending'], ['Read', 'Write', 'Test', 'Ship']),
      todo('4', ['completed', 'completed', 'completed', 'completed'], ['Read', 'Write', 'Test', 'Ship']),
    ])).toEqual(['0 of 3 done', '1 of 3 done', '1 of 4 done', '4 of 4 done']);
  });

  it('say where they stand on that line, as Tasks', () => {
    const input = { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing' }, { content: 'Test', status: 'pending' }] };
    expect(describeTool('TodoWrite', input)).toMatchObject({ verb: 'Tasks', target: '1 of 3 done' });
    expect(describeTool('TodoWrite', { todos: [] })).toMatchObject({ verb: 'Tasks', target: 'cleared' });
  });
});

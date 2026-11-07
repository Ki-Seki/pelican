import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/shared/protocol';
import { currentTasks } from '../src/shared/tasks';

const call = (id: string, name: string, input: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  uuid: `a-${id}`, role: 'assistant', blocks: [{ type: 'tool_use', id, name, input }], ...extra,
});
const result = (id: string, content: string): ChatMessage => ({
  uuid: `r-${id}`, role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content }],
});

describe('currentTasks', () => {
  it('takes the latest TodoWrite list whole', () => {
    const tasks = currentTasks([
      call('1', 'TodoWrite', { todos: [{ content: 'Old', status: 'pending' }] }),
      call('2', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing' }] }),
    ]);
    expect(tasks).toEqual([
      { content: 'Read', status: 'completed' },
      { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    ]);
  });

  it('follows TaskCreate and TaskUpdate by the number Claude Code gave each task', () => {
    const tasks = currentTasks([
      call('c1', 'TaskCreate', { subject: 'Set up', activeForm: 'Setting up' }),
      result('c1', 'Task #1 created successfully: Set up'),
      call('c2', 'TaskCreate', { subject: 'Test' }),
      result('c2', 'Task #2 created successfully: Test'),
      call('c3', 'TaskCreate', { subject: 'Dropped' }),
      result('c3', 'Task #3 created successfully: Dropped'),
      call('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      call('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Run the tests' }),
      call('u3', 'TaskUpdate', { taskId: '3', status: 'deleted' }),
      call('u4', 'TaskUpdate', { taskId: '9', status: 'completed' }),
    ]);
    expect(tasks).toEqual([
      { content: 'Set up', status: 'completed', activeForm: 'Setting up' },
      { content: 'Run the tests', status: 'in_progress' },
    ]);
  });

  it('leaves out a call that failed: a list Claude Code refused never becomes the live one', () => {
    const failed = (id: string, content: string): ChatMessage => ({
      uuid: `r-${id}`, role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }],
    });
    const before = call('1', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed' }] });
    expect(currentTasks([
      before,
      result('1', 'Todos have been modified successfully'),
      call('2', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Add the dark palette', status: 'in_progress' }] }),
      failed('2', '<tool_use_error>Error: No such tool available: TodoWrite</tool_use_error>'),
    ])).toEqual([{ content: 'Read', status: 'completed' }]);
    expect(currentTasks([
      call('c1', 'TaskCreate', { subject: 'Set up' }),
      failed('c1', 'Task tools are not available here'),
    ])).toEqual([]);
  });

  it('numbers a task whose result has not arrived yet', () => {
    const tasks = currentTasks([call('c1', 'TaskCreate', { subject: 'First' }), call('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]);
    expect(tasks).toEqual([{ content: 'First', status: 'in_progress' }]);
  });

  it('ignores what subagents track', () => {
    const tasks = currentTasks([call('1', 'TodoWrite', { todos: [{ content: 'Inner', status: 'pending' }] }, { parentToolUseId: 'agent' })]);
    expect(tasks).toEqual([]);
  });
});

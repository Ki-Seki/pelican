import type { ChatMessage } from './protocol';

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** The items of a TodoWrite call. */
export function todosOf(input: Record<string, unknown>): Todo[] {
  return Array.isArray(input.todos) ? (input.todos as Todo[]).filter((t) => t && typeof t.content === 'string') : [];
}

/**
 * Claude's task list as it stands after these messages. TodoWrite replaces
 * the whole list; TaskCreate adds one task and TaskUpdate changes one, by the
 * number Claude Code gave it ("Task #3 created successfully"). One that failed
 * (its result an error: the tool refused, or is not there) changed nothing.
 */
export function currentTasks(messages: ChatMessage[]): Todo[] {
  const results = new Map<string, string>();
  const failed = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : block.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      results.set(block.tool_use_id, text);
      if (block.is_error) failed.add(block.tool_use_id);
    }
  }
  let tasks: Array<Todo & { id?: string }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.parentToolUseId) continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || failed.has(block.id)) continue;
      const input = block.input;
      if (block.name === 'TodoWrite') {
        tasks = todosOf(input).map((t) => ({ ...t }));
      } else if (block.name === 'TaskCreate') {
        const id = results.get(block.id)?.match(/Task #(\w+)/)?.[1] ?? String(tasks.length + 1);
        const activeForm = str(input.activeForm);
        tasks.push({ id, content: str(input.subject) ?? str(input.description) ?? 'Task', status: 'pending', ...(activeForm ? { activeForm } : {}) });
      } else if (block.name === 'TaskUpdate') {
        const task = tasks.find((t) => t.id !== undefined && t.id === String(input.taskId));
        if (!task) continue;
        const status = str(input.status);
        if (status === 'deleted') {
          tasks = tasks.filter((t) => t !== task);
          continue;
        }
        if (status && STATUSES.has(status)) task.status = status as Todo['status'];
        if (str(input.subject)) task.content = str(input.subject)!;
        if (str(input.activeForm)) task.activeForm = str(input.activeForm)!;
      }
    }
  }
  return tasks.map(({ id: _id, ...task }) => task);
}

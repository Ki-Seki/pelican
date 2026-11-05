import {
  Bot,
  ChartArea,
  CircleHelp,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  type LucideIcon,
  Plug,
  Search,
  SquareTerminal,
  Workflow,
  Wrench,
} from 'lucide-react';

import { todosOf } from '../../shared/tasks';
import { workflowOf } from '../../shared/workflows';

export type ToolSummary = {
  icon: LucideIcon;
  /** Short verb shown first, e.g. "Read", "Edit". */
  verb: string;
  /** What it acted on: a path, a command, a pattern. */
  target?: string;
  /** `target` is a file path: shown as the file name with its folder dimmed. */
  path?: boolean;
  /** `target` is prose (a command's description), not code. */
  prose?: boolean;
  /** Extra detail after the target, e.g. "lines 10–40". */
  note?: string;
};

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Path relative to the session folder when inside it, else as is. */
export function relPath(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined;
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

export function countLines(text: string | undefined): number {
  if (!text) return 0;
  return text.split('\n').length;
}

export function describeTool(name: string, input: Record<string, unknown>, cwd?: string): ToolSummary {
  switch (name) {
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      const note = offset !== undefined && limit !== undefined ? `lines ${offset}–${offset + limit}` : undefined;
      return { icon: FileText, verb: 'Read', target: relPath(str(input.file_path), cwd), path: true, ...(note ? { note } : {}) };
    }
    case 'Edit':
    case 'MultiEdit':
      return { icon: FilePen, verb: 'Edit', target: relPath(str(input.file_path), cwd), path: true };
    case 'Write':
      return { icon: FilePlus, verb: 'Write', target: relPath(str(input.file_path), cwd), path: true };
    case 'NotebookEdit':
      return { icon: FilePen, verb: 'Edit notebook', target: relPath(str(input.notebook_path), cwd), path: true };
    case 'Bash':
    case 'PowerShell':
      // Claude describes most commands in a few words; that reads better on a phone than the command.
      return str(input.description)
        ? { icon: SquareTerminal, verb: 'Run', target: str(input.description), prose: true }
        : { icon: SquareTerminal, verb: 'Run', target: str(input.command)?.split('\n')[0] };
    case 'Grep':
      return { icon: Search, verb: 'Search', target: str(input.pattern), ...(str(input.path) ? { note: `in ${relPath(str(input.path), cwd)}` } : {}) };
    case 'Glob':
      return { icon: FolderSearch, verb: 'Find', target: str(input.pattern), ...(str(input.path) ? { note: `in ${relPath(str(input.path), cwd)}` } : {}) };
    case 'WebFetch':
      return { icon: Globe, verb: 'Fetch', target: str(input.url) };
    case 'WebSearch':
      return { icon: Globe, verb: 'Search the web', target: str(input.query) };
    case 'Agent':
    case 'Task':
      return { icon: Bot, verb: str(input.subagent_type) ? `Agent · ${str(input.subagent_type)}` : 'Agent', target: str(input.description) };
    case 'TodoWrite': {
      // Where the list stands: "2/4 · Remembering the choice", as the bar above the composer says it.
      const todos = todosOf(input);
      if (todos.length === 0) return { icon: ListChecks, verb: 'Update tasks' };
      const done = todos.filter((t) => t.status === 'completed').length;
      const current = todos.find((t) => t.status === 'in_progress');
      const what = current ? current.activeForm || current.content : done === todos.length ? 'All done' : undefined;
      return { icon: ListChecks, verb: 'Update tasks', target: [`${done}/${todos.length}`, what].filter(Boolean).join(' · '), prose: true };
    }
    case 'TaskCreate':
      return { icon: ListChecks, verb: 'Add task', target: str(input.subject) ?? str(input.title), prose: true };
    case 'TaskUpdate': {
      const status = str(input.status)?.replace('_', ' ');
      return { icon: ListChecks, verb: 'Update task', target: [input.taskId ? `#${String(input.taskId)}` : undefined, status].filter(Boolean).join(' · ') || undefined, prose: true };
    }
    case 'AskUserQuestion':
      return { icon: CircleHelp, verb: 'Asked you' };
    case 'ExitPlanMode':
      return { icon: ClipboardList, verb: 'Proposed a plan' };
    case 'Skill':
      return { icon: Wrench, verb: 'Skill', target: str(input.skill) ?? str(input.command) };
    case 'Workflow': {
      // As Claude Code names it: the script's description, else its name, never the script itself.
      const { name, description } = workflowOf(input);
      return { icon: Workflow, verb: 'Workflow', ...(description ?? name ? { target: description ?? name, prose: true } : {}) };
    }
    default: {
      if (/(^|__)show_widget$/.test(name)) return { icon: ChartArea, verb: 'Drew', target: str(input.title)?.replace(/_/g, ' '), prose: true };
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return { icon: Plug, verb: `${server ?? 'mcp'} · ${tool ?? ''}`.trim(), target: firstString(input) };
      }
      return { icon: Wrench, verb: name, target: firstString(input) };
    }
  }
}

function firstString(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) return value.split('\n')[0];
  }
  return undefined;
}

export { currentTasks, type Todo, todosOf } from '../../shared/tasks';

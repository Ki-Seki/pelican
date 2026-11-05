import type { PermissionMode, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { MODE_INFO } from '../shared/modes.js';

/** Longer than this, a choice no longer reads at a glance; Claude Code drops such a choice too. */
const MAX_LABEL = 200;

const LATER = /:\*$/;

/** A path as a rule spells it (`//abs/**`, `./rel`, `~/x`), short and readable. */
function pathOf(rule: string, home: string): string {
  const plain = rule.replace(/\/\*\*$/, '').replace(/^\.\//, '').replace(/^\/\//, '/');
  return home && (plain === home || plain.startsWith(`${home}/`)) ? `~${plain.slice(home.length)}` : plain;
}

const FILE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** One rule in words: the command pattern, the site, the folder or the tool it lets through. */
function ruleText(rule: { toolName: string; ruleContent?: string }, home: string): string {
  const { toolName, ruleContent: content } = rule;
  if (toolName.startsWith('mcp__')) {
    const [, server, tool] = toolName.split('__');
    return tool ? `${server} · ${tool}` : `every ${server} tool`;
  }
  if (!content) return toolName;
  if (toolName === 'Bash' || toolName === 'PowerShell') return content.replace(LATER, ' *');
  if (toolName === 'WebFetch' && content.startsWith('domain:')) return `fetching ${content.slice('domain:'.length)}`;
  if (toolName === 'Read') return `reading ${pathOf(content, home)}`;
  if (FILE_EDITS.has(toolName)) return `edits in ${pathOf(content, home)}`;
  return `${toolName} ${content}`;
}

type Scope = 'session' | 'project' | 'everywhere';

function scopeOf(destination: string): Scope {
  if (destination === 'userSettings') return 'everywhere';
  if (destination === 'projectSettings' || destination === 'localSettings') return 'project';
  return 'session';
}

const join = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * What "always" would save, in words, from the suggestions Claude Code sent with a request. Like
 * Claude Code it is one choice that applies them all, and it names everything it applies, so a
 * rule saved from it never covers more than it said. Undefined when a suggestion cannot be put in
 * plain words (or there are none): then only a one-time approval is offered.
 */
export function describeAlways(suggestions: PermissionUpdate[] | undefined, home: string): string | undefined {
  if (!suggestions || suggestions.length === 0) return undefined;
  const parts: string[] = [];
  const rules = new Map<Scope, string[]>();
  const dirs = new Map<Scope, string[]>();
  for (const update of suggestions) {
    if (update.type === 'setMode') {
      if (!(update.mode in MODE_INFO)) return undefined;
      const scope = scopeOf(update.destination);
      if (update.mode === 'acceptEdits' && scope === 'session') parts.push('Allow all edits this session');
      else parts.push(`Switch to ${MODE_INFO[update.mode].label} ${scope === 'session' ? 'for this session' : scope === 'project' ? 'in this project' : 'everywhere'}`);
    } else if (update.type === 'addRules') {
      if (update.behavior !== 'allow' || update.rules.length === 0) return undefined;
      const list = rules.get(scopeOf(update.destination)) ?? [];
      for (const rule of update.rules) list.push(ruleText(rule, home));
      rules.set(scopeOf(update.destination), list);
    } else if (update.type === 'addDirectories') {
      if (update.directories.length === 0) return undefined;
      const list = dirs.get(scopeOf(update.destination)) ?? [];
      for (const dir of update.directories) list.push(pathOf(dir, home));
      dirs.set(scopeOf(update.destination), list);
    } else {
      // Removing or replacing rules is never what "allow" should mean.
      return undefined;
    }
  }
  for (const [scope, list] of rules) {
    const items = [...new Set(list)];
    parts.push(scope === 'session' ? `Allow ${join(items)} for this session` : `Always allow ${join(items)} ${scope === 'project' ? 'in this project' : 'in every project'}`);
  }
  for (const [scope, list] of dirs) {
    const items = [...new Set(list)];
    parts.push(`Allow access to ${join(items)} ${scope === 'session' ? 'for this session' : scope === 'project' ? 'from this project' : 'from every project'}`);
  }
  const label = parts.map((part, i) => (i === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1))).join('; ');
  return label && label.length <= MAX_LABEL ? label : undefined;
}

/** The mode a set of suggestions switches this session to, if any. */
export function sessionModeOf(suggestions: PermissionUpdate[] | undefined): PermissionMode | undefined {
  const update = suggestions?.find((s) => s.type === 'setMode' && scopeOf(s.destination) === 'session');
  return update?.type === 'setMode' ? update.mode : undefined;
}

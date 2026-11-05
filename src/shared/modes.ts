import type { PermissionMode as ClaudeCodeMode } from '@anthropic-ai/claude-agent-sdk';

/** Claude Code's permission modes, in the order its Shift+Tab cycles through them. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Claude Code adding or dropping a mode fails the typecheck here instead of a session silently
// falling back to Manual.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ModesMatchClaudeCode = Assert<Same<PermissionMode, ClaudeCodeMode>>;

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  (PERMISSION_MODES as readonly unknown[]).includes(value);

/**
 * Names as Claude Code, Claude Desktop and the docs give them, and what runs without asking in
 * each (code.claude.com/docs/en/permission-modes). `now` is said when a session switches to the
 * mode without it being picked here.
 */
export const MODE_INFO: Record<PermissionMode, { label: string; short: string; description: string; now: string }> = {
  default: {
    label: 'Manual',
    short: 'Manual',
    description: 'Asks before edits and commands',
    now: 'Now asking before edits and commands.',
  },
  acceptEdits: {
    label: 'Accept edits',
    short: 'Accept edits',
    description: 'Edits files and runs mkdir, mv, rm… here without asking',
    now: 'Now accepting edits for this session.',
  },
  plan: {
    label: 'Plan',
    short: 'Plan',
    description: 'Reads and plans; changes nothing until you approve',
    now: 'Now planning: nothing changes until you approve the plan.',
  },
  auto: {
    label: 'Auto',
    short: 'Auto',
    description: 'Runs everything, with safety checks in the background',
    now: 'Now in auto mode.',
  },
  bypassPermissions: {
    label: 'Bypass permissions',
    short: 'Bypass',
    description: 'Runs everything without asking. Only for isolated machines',
    now: 'Now running everything without asking.',
  },
  dontAsk: {
    label: 'Don’t ask',
    short: 'Don’t ask',
    description: 'Runs only what is allowed already; denies the rest',
    now: 'Now denying anything that would ask you.',
  },
};

/**
 * The modes Pelican offers to pick. Don't ask is Claude Code's mode for scripts and CI: a
 * session in it keeps it and shows it, but it is never offered.
 */
export const OFFERED_MODES: readonly PermissionMode[] = PERMISSION_MODES.filter((mode) => mode !== 'dontAsk');

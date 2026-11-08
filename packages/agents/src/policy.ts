import path from 'node:path';
import { commandParts } from './runtime';

/**
 * Tool-use policy applied to every agent tool call (via the Agent SDK PreToolUse
 * hook). This is defense in depth on top of the runtime's permission system and
 * optional OS sandbox. It is NOT a sandbox: shell commands can do anything the
 * user's account can do, which is why Orbit requires either a sandbox or explicit
 * trusted-local consent.
 */
export interface ToolPolicy {
  cwd: string;
  readRoots: string[];
  access: 'read-only' | 'workspace-write';
  allowNetworkTools: boolean;
  /** When set, only these exact command parts run; others are refused as needing approval. */
  allowedCommands?: string[] | null;
  /** Working sessions: commit and push are allowed (with approval); see `deniedCommandReason`. */
  allowGit?: boolean;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string; needsApproval?: boolean };

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const ALWAYS_OK = new Set(['TodoWrite']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const ENGINEER_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'PowerShell', 'TodoWrite'] as const;

/** Refused everywhere: Autopilot and working sessions. */
const DENIED_COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+(?:-c\s+\S+\s+)*push\b[^\n;&|]*?(\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/i, 'Force pushes are not allowed.'],
  [/\bgit\s+(?:-c\s+\S+\s+)*(remote\s+(?:add|remove|rm|rename|set-url|set-head)|credential|config\s+--(?:global|system))\b/i, 'Changing git remotes, credentials or global settings is not allowed.'],
  [/\bgit\s+(?:-c\s+\S+\s+)*(reset\s+--hard|rebase|filter-branch|filter-repo)\b/i, 'Rewriting git history is not allowed.'],
  [/(^|[\s;&|(])gh\s/i, 'GitHub actions go through Orbit approval gates.'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b/i, 'Publishing packages is not allowed.'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)\b/i, 'Piping downloads into a shell is not allowed.'],
  [/\bsudo\b/i, 'Elevated commands are not allowed.'],
  [/(^|[\s;&|(])(ssh|scp|sftp)\s/i, 'Remote shells are not allowed.'],
  [/\brm\s+-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*(\/|~|\$HOME|[a-z]:[\\/])(\s|$)/i, 'Recursive deletes outside the worktree are not allowed.'],
  [/\b(Remove-Item|rmdir|rd)\b[^\n]*\s([a-z]:[\\/]?|~|\$HOME|\$env:USERPROFILE)(\s|$)/i, 'Recursive deletes outside the worktree are not allowed.'],
  [/\b(printenv|env)\s*$|\bGet-ChildItem\s+env:|\bset\s*$/i, 'Dumping the environment is not allowed.'],
];

/**
 * Refused in Autopilot, where Orbit itself commits and pushes after your approval. In a
 * working session the developer asks for these, so they run like any other command.
 */
const MISSION_ONLY_DENIED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+(?:-c\s+\S+\s+)*(push|remote)\b/i, 'Orbit pushes branches itself after your approval.'],
  [/\bgit\s+(?:-c\s+\S+\s+)*(commit|checkout\s+(?:main|master)|merge)\b/i, 'Orbit owns commits and branches in the mission worktree.'],
];

/** Why Orbit refuses a shell command outright, or null when it may run (possibly after approval). */
export function deniedCommandReason(command: string, opts: { allowGit?: boolean } = {}): string | null {
  for (const [pattern, reason] of DENIED_COMMANDS) if (pattern.test(command)) return reason;
  if (!opts.allowGit) for (const [pattern, reason] of MISSION_ONLY_DENIED) if (pattern.test(command)) return reason;
  return null;
}

const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc)$/i;
const ALLOWED_ENV_EXAMPLES = /(^|[\\/])\.env\.(example|sample|template)$/i;

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInside(root: string, target: string): boolean {
  const r = normalize(root);
  const t = normalize(target);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function inGitDir(root: string, target: string): boolean {
  const rel = path.relative(normalize(root), normalize(target));
  return rel.split(/[\\/]/).includes('.git');
}

function inputPaths(tool: string, input: Record<string, unknown>): string[] {
  const keys = tool === 'NotebookEdit' ? ['notebook_path'] : ['file_path', 'path', 'notebook_path'];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

export function evaluateToolUse(tool: string, rawInput: unknown, policy: ToolPolicy): PolicyDecision {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const roots = [policy.cwd, ...policy.readRoots];

  if (ALWAYS_OK.has(tool)) return { allow: true };

  if (NETWORK_TOOLS.has(tool)) {
    return policy.allowNetworkTools ? { allow: true } : { allow: false, reason: `${tool} is disabled for Orbit agents (enable agent network access in Settings).` };
  }

  if (READ_TOOLS.has(tool)) {
    const paths = inputPaths(tool, input);
    for (const p of paths) {
      const abs = path.resolve(policy.cwd, p);
      if (!roots.some((r) => isInside(r, abs))) return { allow: false, reason: `Reading outside the authorized repositories is not allowed: ${p}` };
      if (SECRET_FILE.test(abs) && !ALLOWED_ENV_EXAMPLES.test(abs)) return { allow: false, reason: `Reading likely secret files is not allowed: ${path.basename(abs)}` };
    }
    return { allow: true };
  }

  if (WRITE_TOOLS.has(tool)) {
    if (policy.access !== 'workspace-write') return { allow: false, reason: 'This agent role is read-only.' };
    const paths = inputPaths(tool, input);
    if (paths.length === 0) return { allow: false, reason: `${tool} call without a file path.` };
    for (const p of paths) {
      const abs = path.resolve(policy.cwd, p);
      if (!isInside(policy.cwd, abs)) return { allow: false, reason: `Writes are only allowed inside the mission worktree: ${p}` };
      if (inGitDir(policy.cwd, abs)) return { allow: false, reason: 'Writing inside .git is not allowed.' };
    }
    return { allow: true };
  }

  if (SHELL_TOOLS.has(tool)) {
    if (policy.access !== 'workspace-write') return { allow: false, reason: 'This agent role cannot run commands.' };
    const command = typeof input.command === 'string' ? input.command : '';
    const denied = deniedCommandReason(command, { allowGit: policy.allowGit });
    if (denied) return { allow: false, reason: denied };
    if (policy.allowedCommands && !commandParts(command).every((part) => policy.allowedCommands!.includes(part))) {
      return { allow: false, reason: 'This command needs your approval first.', needsApproval: true };
    }
    return { allow: true };
  }

  return { allow: false, reason: `${tool} is not enabled for Orbit agents.` };
}

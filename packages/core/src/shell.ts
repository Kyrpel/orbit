import { buildAgentEnv } from '@orbit/agents';
import { OrbitError, redactSecrets } from '@orbit/shared';
import type { OrbitContext } from './context';

/*
  `!command` in a session prompt, like Claude Code's bash mode: you run a command in the project
  yourself, right now, and the agent hears about it on its next message. It is your own command,
  so Orbit's agent rules do not apply, but it gets the same trimmed environment agents get (no
  GitHub, Asana or cloud tokens), a time limit, and a capped, redacted output.
*/

const MAX_COMMAND = 4000;
const TIMEOUT_MS = 120_000;
const KEEP_OUTPUT = 12_000;

export interface ShellRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/**
 * On Windows, a program you installed after Orbit started (say `cursor-agent`) is on the PATH of
 * new terminal windows but not on Orbit's own. Each `!` command first takes the PATH a new window
 * would get (machine, then user) and keeps Orbit's own entries after it.
 */
export const FRESH_WINDOWS_PATH = "$env:Path = (@([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User'), $env:Path) | Where-Object { $_ }) -join ';'; ";

/** The shell Orbit uses for the platform: PowerShell on Windows (as the agents' own shell), sh elsewhere. */
export function shellInvocation(platform: NodeJS.Platform, command: string): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${FRESH_WINDOWS_PATH}${command}`] }
    : { file: '/bin/sh', args: ['-c', command] };
}

export async function runShellCommand(ctx: OrbitContext, cwd: string, rawCommand: string, signal?: AbortSignal): Promise<ShellRun> {
  const command = rawCommand.replace(/^\s*!\s*/, '').trim();
  if (!command) throw new OrbitError('VALIDATION', 'Type a command after the ! first.');
  if (command.length > MAX_COMMAND) throw new OrbitError('VALIDATION', `Commands are limited to ${MAX_COMMAND} characters.`);
  const { file, args } = shellInvocation(ctx.platform, command);
  const res = await ctx.runner.run(file, args, { cwd, env: buildAgentEnv(process.env, {}, false), extendEnv: false, timeoutMs: TIMEOUT_MS, killTree: true, ...(signal ? { signal } : {}) });
  const raw = res.spawnFailed ? (res.errorMessage ?? `Could not start ${file}.`) : res.output;
  const text = redactSecrets(raw.replace(/\r\n?/g, '\n')).replace(/\s+$/, '');
  const output = text.length > KEEP_OUTPUT ? `…\n${text.slice(-KEEP_OUTPUT)}` : text;
  return { output: output || '(No output)', exitCode: res.exitCode, timedOut: res.timedOut, cancelled: res.cancelled, durationMs: res.durationMs };
}

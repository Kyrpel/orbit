import { execa } from 'execa';

/**
 * Process execution for Orbit. Everything runs WITHOUT a shell: the program
 * and its arguments are passed as an argv array, so untrusted text (task
 * titles, branch names, PR bodies) can never be interpreted as shell syntax.
 * On Windows, `.cmd` shims are resolved safely by execa/cross-spawn.
 */
export interface RunOptions {
  cwd?: string;
  /** Extra environment variables merged over the inherited environment (or over `{}` when `extendEnv` is false). */
  env?: Record<string, string | undefined>;
  extendEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Sent to stdin. */
  input?: string;
  /** Live output (stdout + stderr interleaved). */
  onOutput?: (chunk: string) => void;
  /** Kill the whole process tree on timeout or cancel (verification commands spawn children). */
  killTree?: boolean;
}

export interface RunResult {
  file: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** True when the program could not be started at all (e.g. not installed). */
  spawnFailed: boolean;
  ok: boolean;
  errorMessage: string | null;
}

export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<RunResult>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // taskkill /T terminates the whole tree; /F forces it.
    void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false, windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  } catch {
    /* already gone */
  }
}

export const defaultRunner: CommandRunner = {
  async run(file, args, options = {}) {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      controller.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.timeoutMs)
        : null;

    const subprocess = execa(file, args, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: options.extendEnv ?? true,
      input: options.input,
      reject: false,
      all: true,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      stripFinalNewline: true,
      cancelSignal: controller.signal,
      forceKillAfterDelay: 5000,
      detached: options.killTree === true && process.platform !== 'win32',
    });

    if (options.killTree && subprocess.pid) {
      const pid = subprocess.pid;
      controller.signal.addEventListener('abort', () => killProcessTree(pid), { once: true });
    }
    if (options.onOutput && subprocess.all) {
      const emit = options.onOutput;
      subprocess.all.on('data', (chunk: Buffer | string) => emit(chunk.toString()));
    }

    try {
      const result = await subprocess;
      const spawnFailed =
        result.failed && result.exitCode === undefined && result.signal === undefined && !timedOut && !cancelled;
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      const output = typeof result.all === 'string' ? result.all : `${stdout}${stderr ? `\n${stderr}` : ''}`;
      return {
        file,
        args,
        exitCode: result.exitCode ?? null,
        stdout,
        stderr,
        output,
        durationMs: Date.now() - started,
        timedOut,
        cancelled: cancelled && !timedOut,
        spawnFailed,
        ok: !result.failed && result.exitCode === 0,
        errorMessage: result.failed ? (result.shortMessage ?? 'Command failed') : null,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  },
};

export class CommandFailedError extends Error {
  readonly result: RunResult;
  constructor(message: string, result: RunResult) {
    super(message);
    this.name = 'CommandFailedError';
    this.result = result;
  }
}

/** Runs a command and throws `CommandFailedError` unless it exits with 0. */
export async function runChecked(runner: CommandRunner, file: string, args: string[], options?: RunOptions): Promise<RunResult> {
  const result = await runner.run(file, args, options);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || result.errorMessage || '').trim().split('\n').slice(-6).join('\n');
    const why = result.spawnFailed
      ? `could not start "${file}" (is it installed and on PATH?)`
      : result.timedOut
        ? 'timed out'
        : result.cancelled
          ? 'was cancelled'
          : `exited with code ${result.exitCode}`;
    throw new CommandFailedError(`${file} ${args.slice(0, 3).join(' ')} ${why}${detail ? `: ${detail}` : ''}`, result);
  }
  return result;
}

import type { ChildProcess } from 'node:child_process';
import { execa } from 'execa';

/*
 * On Windows a process's children outlive it, and they inherit its output pipe. An AI's
 * launcher (`.cmd` -> PowerShell -> Node), the tool servers it starts and any command it
 * left running (`adb wait-for-device`) all hold Orbit's end open. Stopping only the
 * launcher, or waiting for that pipe to close, can hang a session forever: Stop seems to
 * do nothing and every message sent after it waits in the queue.
 */

/** A Node child process, or an execa subprocess (a Promise that carries one). */
export type Proc = ChildProcess | { nodeChildProcess: ChildProcess };
const child = (p: Proc): ChildProcess => ('nodeChildProcess' in p ? p.nodeChildProcess : p);
const hasExited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** Every process started under `pid` (Windows), found before anything is stopped. */
async function descendants(pid: number): Promise<number[]> {
  const r = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], {
    reject: false,
    windowsHide: true,
    timeout: 15_000,
  });
  const children = new Map<number, number[]>();
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent == null || Number.isNaN(parent) || child === parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      if (found.includes(c)) continue;
      found.push(c);
      walk(c);
    }
  };
  walk(pid);
  return found;
}

/** Stops a process and everything it started. Never throws. */
export async function killProcessTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!pid) return;
  if (platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    return;
  }
  // Look the tree up first: once the launcher is gone, Windows no longer links its children to it.
  const tree = await descendants(pid).catch(() => [] as number[]);
  await execa('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { reject: false, windowsHide: true, timeout: 15_000 }).catch(() => undefined);
  for (const p of tree) {
    try {
      process.kill(p);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Stops a run's process: the whole tree on Windows, then `controller` (execa's cancel
 * signal), so the process is gone even if the tree lookup fails.
 */
export function stopProcess(sub: { pid?: number }, controller: AbortController, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32' && sub.pid) void killProcessTree(sub.pid, platform).finally(() => controller.abort());
  else controller.abort();
}

/**
 * Stops reading once the process itself has exited, even if something it started still
 * holds its output open. Returns a function that cancels this (call it when the run ends).
 */
export function releaseOutputOnExit(proc: Proc, graceMs = 2000): () => void {
  const sub = child(proc);
  let timer: NodeJS.Timeout | undefined;
  // End the stream (readers such as readline only finish on 'end'), then let go of the pipe.
  const end = (s: NodeJS.ReadableStream & { destroyed?: boolean; destroy?: () => void; push?: (chunk: null) => boolean; readableEnded?: boolean }) => {
    if (s.destroyed || s.readableEnded) return;
    s.once('end', () => s.destroy?.());
    s.push?.(null);
    s.resume();
  };
  const onExit = () => {
    timer = setTimeout(() => {
      if (sub.stdout) end(sub.stdout);
      if (sub.stderr) end(sub.stderr);
    }, graceMs);
    timer.unref?.();
  };
  if (hasExited(sub)) onExit();
  else sub.once('exit', onExit);
  return () => {
    sub.removeListener('exit', onExit);
    if (timer) clearTimeout(timer);
  };
}

/** Waits up to `ms` for the process to exit; true when it did. */
export function exitedWithin(proc: Proc, ms: number): Promise<boolean> {
  const sub = child(proc);
  if (hasExited(sub)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.removeListener('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    sub.once('exit', onExit);
  });
}

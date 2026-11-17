import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree, releaseOutputOnExit } from '../src/process-tree';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

// Like an AI's .cmd launcher with `adb wait-for-device` running under it: a command that
// never ends and holds the launcher's output pipe.
const LAUNCHER = `
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
console.log('grandchild ' + g.pid);
setInterval(() => {}, 1000);
`;

describe.runIf(process.platform === 'win32')('stopping an AI process on Windows', () => {
  const leftovers: number[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const pid of leftovers.splice(0)) if (alive(pid)) await killProcessTree(pid);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function launch() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orbit-tree-'));
    dirs.push(dir);
    const file = path.join(dir, 'launcher.cjs');
    writeFileSync(file, LAUNCHER);
    const controller = new AbortController();
    const sub = execa('cmd.exe', ['/d', '/c', process.execPath, file], { reject: false, windowsHide: true, buffer: false, stdout: 'pipe', stderr: 'pipe', cancelSignal: controller.signal });
    let grandchild = 0;
    const reading = (async () => {
      for await (const line of createInterface({ input: sub.stdout! })) {
        const m = /grandchild (\d+)/.exec(line);
        if (m) {
          grandchild = Number(m[1]);
          leftovers.push(grandchild);
        }
      }
    })();
    return { sub, controller, reading, grandchild: () => grandchild };
  }

  it('stops reading once the launcher is gone, even if a command it started still holds the output', async () => {
    const run = launch();
    const release = releaseOutputOnExit(run.sub, 300);
    let endedEarly = false;
    void run.reading.then(() => (endedEarly = true));
    expect(await waitFor(() => run.grandchild() > 0, 15_000)).toBe(true);
    // While the launcher runs, its output stays open.
    await new Promise((r) => setTimeout(r, 1500));
    expect(endedEarly).toBe(false);
    // Stopping only the launcher leaves the command running and holding the pipe...
    run.controller.abort();
    // ...but reading still ends.
    const ended = await Promise.race([run.reading.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
    release();
    expect(ended).toBe(true);
    await run.sub.catch(() => undefined);
  }, 40_000);

  it('stops the launcher and everything it started', async () => {
    const run = launch();
    expect(await waitFor(() => run.grandchild() > 0, 15_000)).toBe(true);
    await killProcessTree(run.sub.pid);
    expect(await waitFor(() => !alive(run.grandchild()), 10_000)).toBe(true);
    const ended = await Promise.race([run.reading.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
    expect(ended).toBe(true);
    await run.sub.catch(() => undefined);
  }, 40_000);
});

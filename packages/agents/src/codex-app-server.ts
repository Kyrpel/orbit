import path from 'node:path';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { redactSecrets, type AgentPlanItem } from '@orbit/shared';
import { emptyResult, isUsageLimitError, type AgentEvent, type AgentRunContext, type AgentRunRequest, type AgentRunResult, type AgentRunStatus } from './runtime';
import { unwrapShellCommand } from './codex-cli';

/**
 * Working sessions on Codex through its app-server (JSON-RPC over stdio) instead of
 * `codex exec`, because only the app-server can take a message in the middle of an
 * answer (`turn/steer`), the way you type into Claude Code while it works.
 *
 * The sandbox is the same as for `codex exec`: workspace-write (or read-only), no
 * network unless allowed, no approvals, and on Windows the "unelevated" sandbox so
 * tools in the user folder run. Unlike missions, the developer's own Codex config
 * (skills, plugins) loads, as it would in their terminal.
 */

type Json = Record<string, unknown>;
type Item = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exitCode?: number | null;
  status?: string;
  aggregatedOutput?: string | null;
  changes?: { path: string; kind?: { type?: string } | string }[];
  query?: string;
  server?: string;
  tool?: string;
};

function shortPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return p.split(/[\\/]+/).slice(-2).join('/');
}

/** Maps app-server notifications onto Orbit's live steps. Exported for tests. */
export function translateAppServerNotification(method: string, params: Json, cwd: string, onEvent: (e: AgentEvent) => void): void {
  const item = (params.item ?? {}) as Item;
  const id = item.id;
  if (method === 'item/started') {
    if (item.type === 'commandExecution' && item.command) {
      const cmd = redactSecrets(unwrapShellCommand(item.command));
      onEvent({ type: 'tool', tool: 'Bash', id, summary: `Run ${cmd.slice(0, 140)}`, step: 'run', target: cmd.slice(0, 300) });
    } else if (item.type === 'fileChange' && item.changes?.length) {
      for (const c of item.changes) {
        const kind = typeof c.kind === 'string' ? c.kind : c.kind?.type;
        const verb = kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit';
        onEvent({ type: 'tool', tool: verb === 'Write' ? 'Write' : 'Edit', id, summary: `${verb} ${path.basename(c.path)}`, step: 'edit', target: shortPath(c.path, cwd) });
      }
    } else if (item.type === 'webSearch') {
      onEvent({ type: 'tool', tool: 'WebSearch', id, summary: `Search the web for ${JSON.stringify(item.query ?? '').slice(0, 80)}`, step: 'web', target: item.query ?? null });
    } else if (item.type === 'mcpToolCall') {
      onEvent({ type: 'tool', tool: item.tool ?? 'tool', id, summary: `${item.server ?? 'mcp'}: ${item.tool ?? 'tool'}`, step: 'other', target: null });
    }
    return;
  }
  if (method === 'item/completed') {
    if (item.type === 'agentMessage' && item.text) onEvent({ type: 'text', text: redactSecrets(item.text) });
    else if (item.type === 'commandExecution' && (item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0))) {
      const out = redactSecrets(String(item.aggregatedOutput ?? '').slice(-1500));
      onEvent({ type: 'tool_result', isError: true, id, summary: `Exit code ${item.exitCode ?? '?'}${out ? `\n${out}` : ''}` });
    } else if (item.type === 'fileChange' && item.status === 'failed') {
      onEvent({ type: 'tool_result', isError: true, id, summary: 'The file change was not applied.' });
    }
    return;
  }
  if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
    const plan: AgentPlanItem[] = (params.plan as { step?: string; status?: string }[]).slice(0, 40).map((p) => ({
      text: redactSecrets(String(p.step ?? '').slice(0, 200)),
      status: p.status === 'completed' ? 'completed' : p.status === 'inProgress' || p.status === 'in_progress' ? 'in_progress' : 'pending',
    }));
    const done = plan.filter((p) => p.status === 'completed').length;
    onEvent({ type: 'tool', tool: 'TodoWrite', summary: `Update plan (${done}/${plan.length} done)`, step: 'plan', target: null, plan });
  }
}

export async function runCodexAppServer(opts: { bin: string; env: Record<string, string>; platform: NodeJS.Platform }, req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
  const started = Date.now();
  const sandbox = req.access === 'workspace-write' ? 'workspace-write' : 'read-only';
  const args = ['app-server'];
  if (opts.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
  if (req.access === 'workspace-write' && req.execution.allowNetworkTools) args.push('-c', 'sandbox_workspace_write.network_access=true');

  const controller = new AbortController();
  const sub = execa(opts.bin, args, {
    cwd: req.cwd,
    env: opts.env,
    extendEnv: false,
    reject: false,
    windowsHide: true,
    cancelSignal: controller.signal,
    forceKillAfterDelay: 3000,
    buffer: false,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  sub.stderr?.on('data', (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 40) stderr.shift();
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const send = (msg: Json) => {
    if (sub.stdin && !sub.stdin.destroyed) sub.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  };
  const call = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnOpen = false;
  let text = '';
  let turnStatus: string | null = null;
  let turnError: string | null = null;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const stopSteering = () => {
    if (!turnOpen) return;
    turnOpen = false;
    ctx.onSteerReady?.(null);
  };

  const rl = sub.stdout ? createInterface({ input: sub.stdout }) : null;
  rl?.on('line', (line) => {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = typeof m.id === 'number' ? m.id : null;
    if (id != null && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      if (m.error) p.reject(new Error(String((m.error as Json).message ?? 'Codex request failed')));
      else p.resolve((m.result ?? {}) as Json);
      return;
    }
    const method = typeof m.method === 'string' ? m.method : '';
    const params = (m.params ?? {}) as Json;
    if (id != null && method) {
      // A request from Codex (an approval): Orbit never approves anything outside the sandbox.
      send({ id, error: { code: -32601, message: 'Orbit does not approve actions outside the sandbox.' } });
      return;
    }
    if (method === 'turn/started') {
      turnId = String(((params.turn ?? {}) as Json).id ?? '') || turnId;
      turnOpen = true;
      ctx.onSteerReady?.((message) => {
        if (!turnOpen || !threadId || !turnId) return false;
        call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message }] }).catch(() => {
          ctx.onEvent({ type: 'status', message: 'A message arrived just as Codex finished, so it was not read. Send it again.' });
        });
        return true;
      });
    } else if (method === 'turn/completed') {
      const turn = (params.turn ?? {}) as Json;
      turnStatus = String(turn.status ?? 'completed');
      const err = turn.error as Json | null | undefined;
      turnError = err?.message ? String(err.message) : null;
      stopSteering();
      finished();
    } else if (method === 'error') {
      const err = (params.error ?? params) as Json;
      if (err.message) turnError = String(err.message);
    } else {
      if (method === 'item/completed' && ((params.item ?? {}) as Item).type === 'agentMessage') text = String(((params.item ?? {}) as Item).text ?? '') || text;
      translateAppServerNotification(method, params, req.cwd, ctx.onEvent);
    }
  });
  void sub.then(() => finished(), () => finished());

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void interrupt();
  }, req.timeoutMs);
  const interrupt = async () => {
    stopSteering();
    if (threadId && turnId) await call('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    setTimeout(() => controller.abort(), 3000);
  };
  const onAbort = () => void interrupt();
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await call('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '0.1.0' } });
    send({ method: 'initialized' });
    const instructions = `${req.systemAppend}${req.readRoots.length ? `\n\nYou may also read (never modify) these directories:\n${req.readRoots.map((r) => `- ${r}`).join('\n')}` : ''}`;
    const threadParams = { cwd: req.cwd, sandbox, approvalPolicy: 'never', developerInstructions: instructions, ...(req.model ? { model: req.model } : {}) };
    const resumeId = req.session?.resumeId;
    const thread = resumeId
      ? await call('thread/resume', { threadId: resumeId, ...threadParams, excludeTurns: true })
      : await call('thread/start', { ...threadParams, ephemeral: !req.session?.persist });
    threadId = String(((thread.thread ?? {}) as Json).id ?? resumeId ?? '');
    ctx.onEvent({ type: 'status', message: `Session ${resumeId ? 'continued' : 'started'}${req.model ? ` (${req.model})` : ' (Codex default model)'}` });
    await call('turn/start', { threadId, input: [{ type: 'text', text: req.prompt }], ...(req.effort ? { effort: req.effort } : {}) });
    await done;
  } catch (err) {
    turnError = turnError ?? (err as Error).message;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    stopSteering();
    sub.stdin?.end();
    controller.abort();
    await sub.catch(() => undefined);
  }

  const errText = turnError ?? (turnStatus ? null : stderr.join('').slice(-1500) || 'Codex stopped without finishing the answer.');
  const status: AgentRunStatus = timedOut
    ? 'timeout'
    : ctx.signal.aborted || turnStatus === 'interrupted'
      ? 'cancelled'
      : turnStatus === 'completed' && !turnError
        ? 'succeeded'
        : isUsageLimitError(errText)
          ? 'rate_limited'
          : 'failed';
  if (status !== 'succeeded' && status !== 'cancelled' && !threadId) {
    return emptyResult({ status, durationMs: Date.now() - started, text: redactSecrets(text), error: redactSecrets(errText ?? 'Codex failed.') });
  }
  return {
    status,
    text: redactSecrets(text),
    structured: null,
    costUsd: null,
    usage: null,
    numTurns: turnStatus ? 1 : null,
    durationMs: Date.now() - started,
    sessionId: threadId,
    model: req.model,
    error: status === 'succeeded' ? null : redactSecrets(errText ?? 'Codex failed.'),
    deniedTools: [],
  };
}

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliRuntime, isUsageLimitError, parseAssistantReply, translateCodexEvent, unwrapShellCommand, type AgentEvent, type AgentRunRequest } from '../src';

const cwd = path.resolve('/work/wt');

function req(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    role: 'engineer',
    prompt: 'Do it',
    systemAppend: 'You are the engineer.',
    cwd,
    readRoots: [],
    access: 'workspace-write',
    maxTurns: 10,
    timeoutMs: 1000,
    maxBudgetUsd: null,
    model: null,
    effort: null,
    outputSchema: null,
    execution: { mode: 'sandbox', allowNetworkTools: false },
    ...over,
  };
}

describe('Codex command display', () => {
  it('strips the PowerShell and bash wrappers Codex adds', () => {
    expect(unwrapShellCommand(`"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'npm test'`)).toBe('npm test');
    expect(unwrapShellCommand(`"powershell.exe" -Command 'Get-Content ''a b.txt'''`)).toBe("Get-Content 'a b.txt'");
    expect(unwrapShellCommand(`/bin/bash -lc 'pnpm vitest run'`)).toBe('pnpm vitest run');
    expect(unwrapShellCommand('git status')).toBe('git status');
  });
});

describe('Codex event translation', () => {
  const run = (events: object[]) => {
    const out: AgentEvent[] = [];
    for (const e of events) translateCodexEvent(e, cwd, (x) => out.push(x));
    return out;
  };

  it('maps commands, file changes, messages and failures onto Orbit steps', () => {
    const out = run([
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Looking at the cart.' } },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `bash -lc 'npm test'`, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `bash -lc 'npm test'`, exit_code: 1, aggregated_output: '1 failing', status: 'failed' } },
      { type: 'item.started', item: { id: 'item_2', type: 'file_change', changes: [{ path: path.join(cwd, 'src', 'cart.ts'), kind: 'update' }, { path: path.join(cwd, 'test.js'), kind: 'add' }], status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'ok', status: 'completed' } },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'Looking at the cart.' },
      { type: 'tool', tool: 'Bash', id: 'item_1', summary: 'Run npm test', step: 'run', target: 'npm test' },
      { type: 'tool_result', isError: true, id: 'item_1', summary: 'Exit code 1\n1 failing' },
      { type: 'tool', tool: 'Edit', id: 'item_2', summary: 'Edit cart.ts', step: 'edit', target: 'src/cart.ts' },
      { type: 'tool', tool: 'Write', id: 'item_2', summary: 'Write test.js', step: 'edit', target: 'test.js' },
    ]);
  });

  it('turns the to-do list into a plan with the first open item in progress', () => {
    const out = run([{ type: 'item.updated', item: { id: 't', type: 'todo_list', items: [{ text: 'Add param', completed: true }, { text: 'Tests', completed: false }, { text: 'Docs', completed: false }] } }]);
    expect(out[0]).toMatchObject({
      type: 'tool',
      step: 'plan',
      summary: 'Update plan (1/3 done)',
      plan: [
        { text: 'Add param', status: 'completed' },
        { text: 'Tests', status: 'in_progress' },
        { text: 'Docs', status: 'pending' },
      ],
    });
  });
});

describe('Codex arguments', () => {
  it('sandboxes by role, ignores user config, and applies the Windows sandbox fix', () => {
    const win = new CodexCliRuntime('codex', {}, 'win32');
    const engineer = win.buildArgs(req({ model: 'gpt-6-sol', effort: 'xhigh' }), '/tmp/schema.json');
    expect(engineer).toEqual(
      expect.arrayContaining(['exec', '--json', '--ephemeral', '--ignore-user-config', '-s', 'workspace-write', '-c', 'windows.sandbox="unelevated"', '-m', 'gpt-6-sol', 'model_reasoning_effort="xhigh"', '--output-schema', '/tmp/schema.json']),
    );
    expect(engineer).not.toContain('sandbox_workspace_write.network_access=true');
    expect(engineer.at(-1)).toBe('-');

    const linux = new CodexCliRuntime('codex', {}, 'linux');
    const reviewer = linux.buildArgs(req({ role: 'reviewer', access: 'read-only', execution: { mode: 'trusted-local', allowNetworkTools: true } }), null);
    expect(reviewer).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(reviewer).not.toContain('windows.sandbox="unelevated"');
    // Network is only ever opened for the writing sandbox, and only when allowed.
    expect(reviewer).not.toContain('sandbox_workspace_write.network_access=true');
    expect(reviewer).not.toContain('--output-schema');
  });

  it('puts role instructions and readable folders ahead of the task', () => {
    const p = new CodexCliRuntime('codex', {}, 'linux').buildPrompt(req({ readRoots: ['/work/other'] }));
    expect(p.startsWith('<orbit_role_instructions>\nYou are the engineer.')).toBe(true);
    expect(p).toContain('- /work/other');
    expect(p.endsWith('Do it')).toBe(true);
  });
});

describe('usage limits and Assistant replies', () => {
  it('recognises usage-limit errors from either AI', () => {
    expect(isUsageLimitError("Claude AI usage limit reached|1762344000")).toBe(true);
    expect(isUsageLimitError("You've hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(isUsageLimitError('HTTP 429 Too Many Requests')).toBe(true);
    expect(isUsageLimitError('TypeError: x is undefined')).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });

  it('separates a mission proposal from the visible answer', () => {
    const reply = 'Discounts live in `src/cart.ts`.\n\n```orbit-mission\n{"title": "Add percentage discounts", "description": "Support 0-100%", "projects": ["shop-api"]}\n```\n';
    expect(parseAssistantReply(reply)).toEqual({
      answer: 'Discounts live in `src/cart.ts`.',
      mission: { title: 'Add percentage discounts', description: 'Support 0-100%', projects: ['shop-api'] },
    });
    expect(parseAssistantReply('Just an answer.')).toEqual({ answer: 'Just an answer.', mission: null });
    expect(parseAssistantReply('Hi\n```orbit-mission\nnot json\n```').mission).toBeNull();
  });
});

describe('Claude Code arguments for working sessions', () => {
  it('loads only the user setting source, resumes, and passes allowed commands as exact per-part rules', async () => {
    const { ClaudeCodeCliRuntime } = await import('../src');
    const rt = new ClaudeCodeCliRuntime('claude', {});
    const session = rt.buildArgs(
      req({ userEnvironment: true, session: { resumeId: 'abc', persist: true }, commands: { mode: 'allowlist', allowed: ['npm test', 'cd "C:/my app" && sed -n 80,200p README.md'] } }),
    );
    expect(session).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--resume', 'abc', '--permission-mode', 'dontAsk']));
    expect(session).not.toContain('--restricted');
    expect(session).not.toContain('--no-session-persistence');
    expect(session).not.toContain('Bash');
    const settings = JSON.parse(session[session.indexOf('--settings') + 1] ?? '{}') as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual([
      'Bash(npm test)',
      'PowerShell(npm test)',
      'Bash(cd "C:/my app")',
      'PowerShell(cd "C:/my app")',
      'Bash(sed -n 80,200p README.md)',
      'PowerShell(sed -n 80,200p README.md)',
    ]);
  });

  it('uses Claude Code auto mode for Auto sessions and keeps missions as they were', async () => {
    const { ClaudeCodeCliRuntime } = await import('../src');
    const rt = new ClaudeCodeCliRuntime('claude', {});
    const auto = rt.buildArgs(req({ userEnvironment: true, commands: { mode: 'auto', allowed: [] }, execution: { mode: 'trusted-local', allowNetworkTools: false } }));
    expect(auto).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    expect(auto).not.toContain('Bash');
    expect(auto).not.toContain('--settings');

    const mission = rt.buildArgs(req());
    expect(mission).toEqual(expect.arrayContaining(['--restricted', '--no-session-persistence', '--permission-mode', 'dontAsk', 'Bash', 'PowerShell']));
    expect(mission).not.toContain('--setting-sources');
    // Orbit's hard limits apply in every mode.
    expect(auto[auto.indexOf('--disallowedTools') + 1]).toContain('Bash(git push *)');
  });
});

describe('command parts', () => {
  it('splits a shell line the way permission checks see it', async () => {
    const { commandParts, isAllowableCommand } = await import('../src');
    expect(commandParts('cd "C:/Users/me/connect phone to laptop" && sed -n 80,200p README.md; ls batches; adb devices')).toEqual([
      'cd "C:/Users/me/connect phone to laptop"',
      'sed -n 80,200p README.md',
      'ls batches',
      'adb devices',
    ]);
    expect(commandParts(`echo "a && b; c" | grep a || true`)).toEqual(['echo "a && b; c"', 'grep a', 'true']);
    expect(commandParts("node -e 'console.log(1, 2)'")).toEqual(["node -e 'console.log(1, 2)'"]);
    expect(isAllowableCommand('sed -n 80,200p README.md')).toBe(true);
    expect(isAllowableCommand('   ')).toBe(false);
    expect(isAllowableCommand('x'.repeat(5000))).toBe(false);
  });
});

describe('Codex app-server events', () => {
  it('maps commands, file changes, messages, failures and plans onto Orbit steps', async () => {
    const { translateAppServerNotification } = await import('../src');
    const out: AgentEvent[] = [];
    const on = (m: string, p: object) => translateAppServerNotification(m, p as Record<string, unknown>, cwd, (e) => out.push(e));
    on('item/started', { item: { id: 'c1', type: 'commandExecution', command: `"powershell.exe" -Command 'npm test'`, status: 'inProgress' } });
    on('item/completed', { item: { id: 'c1', type: 'commandExecution', command: 'npm test', exitCode: 1, aggregatedOutput: '1 failing', status: 'failed' } });
    on('item/started', { item: { id: 'f1', type: 'fileChange', changes: [{ path: path.join(cwd, 'src', 'a.ts'), kind: { type: 'update' }, diff: '' }, { path: path.join(cwd, 'b.ts'), kind: { type: 'add' }, diff: '' }] } });
    on('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'Done.' } });
    on('item/completed', { item: { id: 'u1', type: 'userMessage' } });
    on('turn/plan/updated', { plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'inProgress' }] });
    expect(out).toEqual([
      { type: 'tool', tool: 'Bash', id: 'c1', summary: 'Run npm test', step: 'run', target: 'npm test' },
      { type: 'tool_result', isError: true, id: 'c1', summary: 'Exit code 1\n1 failing' },
      { type: 'tool', tool: 'Edit', id: 'f1', summary: 'Edit a.ts', step: 'edit', target: 'src/a.ts' },
      { type: 'tool', tool: 'Write', id: 'f1', summary: 'Write b.ts', step: 'edit', target: 'b.ts' },
      { type: 'text', text: 'Done.' },
      { type: 'tool', tool: 'TodoWrite', summary: 'Update plan (1/2 done)', step: 'plan', target: null, plan: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'in_progress' }] },
    ]);
  });
});

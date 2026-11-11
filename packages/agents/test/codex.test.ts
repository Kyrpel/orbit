import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexCliRuntime, codexWebArgs, isUsageLimitError, parseAssistantReply, translateCodexEvent, unwrapShellCommand, type AgentEvent, type AgentRunRequest } from '../src';

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
      { type: 'tool_result', isError: false, id: 'item_3', summary: '', output: { text: 'ok' } },
    ]);
  });

  it('shows Codex opening a page as Fetch and a search as Web Search, once each', () => {
    const out: AgentEvent[] = [];
    const seen = new Set<string>();
    const on = (e: object) => translateCodexEvent(e, cwd, (x) => out.push(x), seen);
    // The step starts before Codex says what it is doing: nothing to show yet.
    on({ type: 'item.started', item: { id: 'w1', type: 'web_search', query: '' } });
    on({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'codex approval never', action: { type: 'search', query: 'codex approval never', queries: null } } });
    on({ type: 'item.completed', item: { id: 'w2', type: 'web_search', query: 'https://example.com/docs', action: { type: 'open_page', url: 'https://example.com/docs' } } });
    // Known at the start: shown then, and not again when it completes.
    on({ type: 'item.started', item: { id: 'w3', type: 'web_search', query: 'https://example.com/b', action: { type: 'open_page', url: 'https://example.com/b' } } });
    on({ type: 'item.completed', item: { id: 'w3', type: 'web_search', query: 'https://example.com/b', action: { type: 'open_page', url: 'https://example.com/b' } } });
    expect(out).toEqual([
      { type: 'tool', tool: 'WebSearch', id: 'w1', summary: 'Search the web for "codex approval never"', step: 'web', target: 'codex approval never' },
      { type: 'tool', tool: 'WebFetch', id: 'w2', summary: 'Fetch https://example.com/docs', step: 'web', target: 'https://example.com/docs' },
      { type: 'tool', tool: 'WebFetch', id: 'w3', summary: 'Fetch https://example.com/b', step: 'web', target: 'https://example.com/b' },
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

  it("makes Codex's own web tool follow the web switch", () => {
    const rt = new CodexCliRuntime('codex', {}, 'linux');
    expect(rt.buildArgs(req(), null)).toEqual(expect.arrayContaining(['-c', 'web_search="disabled"']));
    expect(rt.buildArgs(req({ execution: { mode: 'trusted-local', allowNetworkTools: true } }), null)).toEqual(expect.arrayContaining(['-c', 'web_search="live"']));
    expect(codexWebArgs(false)).toEqual(['-c', 'web_search="disabled"']);
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

  it('gives sessions subagents and your own MCP servers, and missions and read-only sessions neither', async () => {
    const { ClaudeCodeCliRuntime } = await import('../src');
    const rt = new ClaudeCodeCliRuntime('claude', {});
    const tools = (a: string[]) => (a[a.indexOf('--tools') + 1] ?? '').split(',');
    const edit = rt.buildArgs(req({ userEnvironment: true, commands: { mode: 'allowlist', allowed: [] } }));
    expect(tools(edit)).toEqual(expect.arrayContaining(['Agent', 'Skill']));
    // Your MCP servers load (no strict MCP config); a project's own .mcp.json never does under user settings.
    expect(edit).not.toContain('--strict-mcp-config');

    // Read-only sessions (Ask, plan mode) keep "never changes anything": no MCP servers.
    const readOnly = rt.buildArgs(req({ userEnvironment: true, access: 'read-only' }));
    expect(tools(readOnly)).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Agent', 'Skill']));
    expect(tools(readOnly)).not.toContain('Edit');
    expect(readOnly).toContain('--strict-mcp-config');

    // Missions: no subagents, no MCP servers.
    const mission = rt.buildArgs(req());
    expect(tools(mission)).not.toContain('Agent');
    expect(mission).toContain('--strict-mcp-config');
  });

  it("reads the context window from a result's per-model usage", async () => {
    const { contextWindowOf } = await import('../src');
    expect(contextWindowOf({ 'claude-haiku-5-5': { contextWindow: 1_000_000 } }, 'claude-haiku-5-5')).toBe(1_000_000);
    expect(contextWindowOf({ a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } }, 'other')).toBe(1_000_000);
    expect(contextWindowOf(undefined, null)).toBeNull();
  });
});

describe('session prompts', () => {
  it('carries a compacted summary ahead of the history, and shell output the developer ran', async () => {
    const { sessionPrompt, shellContext, compactPrompt, SESSION_PLAN_SYSTEM } = await import('../src');
    const project = { name: 'shop', path: '/p', languages: [], frameworks: [], topLevel: [] };
    const p = sessionPrompt({ message: 'Next step', project, intro: true, summary: 'We added discounts.', history: [{ role: 'user', content: 'later question' }] });
    expect(p.indexOf('We added discounts.')).toBeGreaterThan(-1);
    expect(p.indexOf('We added discounts.')).toBeLessThan(p.indexOf('later question'));
    expect(p.endsWith('Next step')).toBe(true);
    expect(sessionPrompt({ message: 'Next step', project, intro: false, summary: 'x' })).toBe('Next step');

    expect(shellContext([])).toBe('');
    const ctx = shellContext([{ command: 'npm test', output: '1 failing', exitCode: 1 }]);
    expect(ctx).toContain('$ npm test\n1 failing\n(exit code 1)');
    expect(ctx).toContain('<untrusted_command_output>');
    expect(compactPrompt('the API')).toContain('Focus especially on: the API');
    expect(SESSION_PLAN_SYSTEM).toContain('read-only');
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
      { type: 'tool', tool: 'PowerShell', id: 'c1', summary: 'Run npm test', step: 'run', target: 'npm test' },
      { type: 'tool_result', isError: true, id: 'c1', summary: 'Exit code 1\n1 failing' },
      { type: 'tool', tool: 'Edit', id: 'f1', summary: 'Edit a.ts', step: 'edit', target: 'src/a.ts' },
      { type: 'tool', tool: 'Write', id: 'f1', summary: 'Write b.ts', step: 'edit', target: 'b.ts' },
      { type: 'text', text: 'Done.' },
      { type: 'tool', tool: 'TodoWrite', summary: 'Update plan (1/2 done)', step: 'plan', target: null, plan: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'in_progress' }] },
    ]);
  });

  it('shows pages Codex opens as Fetch, with the address, and its searches as Web Search', async () => {
    const { translateAppServerNotification } = await import('../src');
    const out: AgentEvent[] = [];
    const seen = new Set<string>();
    const on = (m: string, p: object) => translateAppServerNotification(m, p as Record<string, unknown>, cwd, (e) => out.push(e), seen);
    on('item/started', { item: { id: 'w1', type: 'webSearch', query: '', action: null } });
    on('item/completed', { item: { id: 'w1', type: 'webSearch', query: 'vercel dns a record', action: { type: 'search', query: 'vercel dns a record', queries: ['vercel dns a record'] } } });
    on('item/completed', { item: { id: 'w2', type: 'webSearch', query: 'https://learn.chatgpt.com/docs/agent-approvals-security', action: { type: 'openPage', url: 'https://learn.chatgpt.com/docs/agent-approvals-security' } } });
    on('item/completed', { item: { id: 'w3', type: 'webSearch', query: 'approval', action: { type: 'findInPage', url: 'https://learn.chatgpt.com/docs/agent-approvals-security', pattern: 'approval' } } });
    // An unspecified action whose query is only an address is still a page being opened.
    on('item/completed', { item: { id: 'w4', type: 'webSearch', query: 'https://example.com/x', action: { type: 'other' } } });
    // The same step reported twice is shown once.
    on('item/completed', { item: { id: 'w2', type: 'webSearch', query: 'https://learn.chatgpt.com/docs/agent-approvals-security', action: { type: 'openPage', url: 'https://learn.chatgpt.com/docs/agent-approvals-security' } } });
    expect(out).toEqual([
      { type: 'tool', tool: 'WebSearch', id: 'w1', summary: 'Search the web for "vercel dns a record"', step: 'web', target: 'vercel dns a record' },
      { type: 'tool', tool: 'WebFetch', id: 'w2', summary: 'Fetch https://learn.chatgpt.com/docs/agent-approvals-security', step: 'web', target: 'https://learn.chatgpt.com/docs/agent-approvals-security' },
      { type: 'tool', tool: 'WebFetch', id: 'w3', summary: 'Fetch https://learn.chatgpt.com/docs/agent-approvals-security', step: 'web', target: 'https://learn.chatgpt.com/docs/agent-approvals-security' },
      { type: 'tool', tool: 'WebFetch', id: 'w4', summary: 'Fetch https://example.com/x', step: 'web', target: 'https://example.com/x' },
    ]);
  });

  it('reports command output and file diffs for the terminal view', async () => {
    const { translateAppServerNotification } = await import('../src');
    const out: AgentEvent[] = [];
    const on = (m: string, p: object) => translateAppServerNotification(m, p as Record<string, unknown>, cwd, (e) => out.push(e));
    on('item/completed', { item: { id: 'c2', type: 'commandExecution', command: 'git status', exitCode: 0, aggregatedOutput: 'l1\nl2\nl3\nl4\nl5\nl6\n', status: 'completed' } });
    on('item/started', {
      item: {
        id: 'f2',
        type: 'fileChange',
        changes: [
          { path: path.join(cwd, 'a.ts'), kind: { type: 'update' }, diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n' },
          { path: path.join(cwd, 'new.ts'), kind: { type: 'add' }, diff: 'one\ntwo\n' },
        ],
      },
    });
    expect(out[0]).toEqual({ type: 'tool_result', isError: false, id: 'c2', summary: '', output: { text: 'l1\nl2\nl3\nl4', lines: 6 } });
    expect(out[1]).toMatchObject({ tool: 'Edit', output: { diff: [' const a = 1;', '-const b = 2;', '+const b = 3;'], added: 1, removed: 1 } });
    expect(out[2]).toMatchObject({ tool: 'Write', output: { diff: ['+one', '+two'], added: 2, removed: 0 } });
  });

  it("counts what one answer used from the thread's running total", async () => {
    const { tokenDelta } = await import('../src');
    // 1,000 input of which 800 cached, 50 output including 10 reasoning; the thread already held 400 input / 300 cached.
    expect(tokenDelta({ inputTokens: 1400, cachedInputTokens: 1100, outputTokens: 70, reasoningOutputTokens: 10 }, { inputTokens: 400, cachedInputTokens: 300, outputTokens: 20, reasoningOutputTokens: 0 })).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });
});

describe('attached images', () => {
  it('sends images to Claude Code as image blocks before the text, and to Codex as local files', async () => {
    const { userContent, codexInput, imageNote } = await import('../src');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-img-'));
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    try {
      expect(userContent('hi')).toBe('hi');
      expect(userContent('What is this? [Image #1]', [{ path: file, mediaType: 'image/png' }])).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } },
        { type: 'text', text: 'What is this? [Image #1]' },
      ]);
      expect(codexInput('See [Image #1]', [{ path: file, mediaType: 'image/png' }])).toEqual([
        { type: 'text', text: 'See [Image #1]' },
        { type: 'localImage', path: file },
      ]);
      expect(imageNote([{ path: file, mediaType: 'image/png' }])).toContain(`[Image #1] ${file}`);
      expect(imageNote(undefined)).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attaches images to fresh Codex exec runs with -i', () => {
    const rt = new CodexCliRuntime('codex', {}, 'linux');
    const args = rt.buildArgs(req({ images: [{ path: '/tmp/a.png', mediaType: 'image/png' }] }), null);
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/tmp/a.png']);
    expect(args.at(-1)).toBe('-');
  });
});

describe('commands Codex runs through PowerShell', () => {
  it('shows a bash command run inside the PowerShell wrapper as Bash with the real command', async () => {
    const { shellName, unwrapShellCommand } = await import('../src');
    const raw = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '& ''C:\Program Files\Git\bin\bash.exe'' -lc "ls -la && cat package.json"'`;
    expect(shellName(raw)).toBe('Bash');
    expect(unwrapShellCommand(raw)).toBe('ls -la && cat package.json');
    expect(shellName(`"powershell.exe" -Command 'Get-ChildItem'`)).toBe('PowerShell');
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURSOR_DENY, CursorCliRuntime, cursorModelId, parseCursorModels, translateCursorToolCall, type AgentRunRequest } from '../src';

/*
  Cursor's own agent (cursor-agent). The events below are shaped like the ones Cursor Agent
  2026.11.11 printed in headless stream-json mode.
*/

const base: AgentRunRequest = {
  role: 'assistant',
  prompt: 'Add a test',
  systemAppend: 'You work through Orbit.',
  cwd: '/work/app',
  readRoots: [],
  access: 'workspace-write',
  maxTurns: 10,
  timeoutMs: 1000,
  maxBudgetUsd: null,
  model: 'cursor:claude-opus-5-5-high',
  effort: 'high',
  outputSchema: null,
  execution: { mode: 'trusted-local', allowNetworkTools: false },
  commands: { mode: 'allowlist', allowed: ['npm test'] },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Cursor CLI runtime', () => {
  it('reads the models your account offers', () => {
    const out = 'Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\ngrok-4.7-low-fast - Grok 4.7  Low Fast​​\n';
    expect(parseCursorModels(out)).toEqual([
      { id: 'auto', label: 'Auto (default)' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'grok-4.7-low-fast', label: 'Grok 4.7 Low Fast' },
    ]);
    expect(cursorModelId('cursor:composer-2.5')).toBe('composer-2.5');
    expect(cursorModelId(null)).toBe('auto');
  });

  it('maps Orbit modes to Cursor: read-only is ask mode, Auto-accept is auto-review, Ask first needs the allow list', () => {
    const rt = new CursorCliRuntime('cursor-agent', {});
    const ask = rt.buildArgs(base);
    expect(ask).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--disable-project-configs', '--model', 'claude-opus-5-5-high']);
    expect(rt.buildArgs({ ...base, commands: { mode: 'auto', allowed: [] } })).toContain('--auto-review');
    expect(rt.buildArgs({ ...base, access: 'read-only', commands: null })).toEqual(expect.arrayContaining(['--mode', 'ask']));
    // Effort is part of a Cursor model's id; nothing else is passed for it.
    expect(ask).not.toContain('--effort');
    const resumed = rt.buildArgs({ ...base, session: { resumeId: 'chat-1', persist: true }, readRoots: ['/other'] });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'chat-1', '--add-dir', '/other']));
    // Long text goes on stdin, never on the command line.
    expect(resumed.join(' ')).not.toContain('Add a test');
  });

  it('sends Orbit\'s instructions with a new chat only, and asks for JSON when a schema is wanted', () => {
    const rt = new CursorCliRuntime('cursor-agent', {});
    expect(rt.buildPrompt(base)).toBe('<orbit_instructions>\nYou work through Orbit.\n</orbit_instructions>\n\nAdd a test');
    expect(rt.buildPrompt({ ...base, session: { resumeId: 'chat-1', persist: true } })).toBe('Add a test');
    expect(rt.buildPrompt({ ...base, systemAppend: '', outputSchema: { type: 'object' } })).toContain('Answer with only one JSON object that matches this JSON Schema');
  });

  it('gives each session its own Cursor settings: your allow list, the commands you allowed here, Orbit\'s deny list', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'orbit-cursor-'));
    dirs.push(home);
    mkdirSync(path.join(home, '.cursor'));
    writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: ['Shell(ls)'], deny: [] }, approvalMode: 'unrestricted', editor: { vimMode: true } }));
    const rt = new CursorCliRuntime('cursor-agent', { USERPROFILE: home, HOME: home });
    const state = path.join(home, 'session');
    rt.writeSettings(state, { ...base, execution: { mode: 'trusted-local', allowNetworkTools: true } });
    const written = JSON.parse(readFileSync(path.join(state, 'cli-config.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['Shell(ls)', 'Shell(npm test)', 'WebFetch(*)']);
    expect(written.permissions.deny).toEqual(CURSOR_DENY);
    expect(written.permissions.deny).toEqual(expect.arrayContaining(['Shell(git push --force)', 'Shell(sudo)', 'Read(**/.env)']));
    expect(written.approvalMode).toBe('allowlist');
    expect(written.editor).toEqual({ vimMode: true }); // your other settings stay
  });

  it('keeps user deny rules and blocks web fetching when the session disables network tools', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'orbit-cursor-'));
    dirs.push(home);
    mkdirSync(path.join(home, '.cursor'));
    writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({ permissions: { allow: ['WebFetch(*)'], deny: ['Read(**/private/**)', 'Shell(curl)'] } }));
    const rt = new CursorCliRuntime('cursor-agent', { USERPROFILE: home, HOME: home });
    const state = path.join(home, 'session');
    rt.writeSettings(state, base);
    const written = JSON.parse(readFileSync(path.join(state, 'cli-config.json'), 'utf8'));
    expect(written.permissions.deny).toEqual(expect.arrayContaining(['Read(**/private/**)', 'Shell(curl)', 'WebFetch(*)', ...CURSOR_DENY]));
    rt.writeSettings(state, { ...base, execution: { mode: 'trusted-local', allowNetworkTools: true } });
    expect(JSON.parse(readFileSync(path.join(state, 'cli-config.json'), 'utf8')).permissions.deny).not.toContain('WebFetch(*)');
  });

  it('fails before spawning when OS isolation is required', async () => {
    const rt = new CursorCliRuntime('must-not-launch', {});
    const result = await rt.run({ ...base, execution: { mode: 'sandbox', allowNetworkTools: false } }, { signal: new AbortController().signal, onEvent: () => {} });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('OS-level isolation') });
  });

  it('turns Cursor\'s tool events into Orbit steps, and records commands that need your OK', () => {
    const denied: { tool: string; reason: string; command?: string }[] = [];
    const shell = (subtype: string, result?: unknown) => ({ type: 'tool_call', subtype, call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm run lint' }, ...(result ? { result } : {}) } } });
    expect(translateCursorToolCall(shell('started'), denied)).toMatchObject({ type: 'tool', tool: 'Bash', summary: 'Run npm run lint', step: 'run', target: 'npm run lint' });
    expect(translateCursorToolCall(shell('completed', { success: { exitCode: 1, interleavedOutput: 'error: x\n' } }), denied)).toMatchObject({ type: 'tool_result', isError: true, summary: 'Exit code 1' });
    expect(translateCursorToolCall(shell('completed', { rejected: { command: 'npm run lint', reason: '' } }), denied)).toMatchObject({ type: 'denied', tool: 'Bash', command: 'npm run lint' });
    expect(denied).toEqual([{ tool: 'Bash', reason: 'Cursor needs your OK to run this command.', command: 'npm run lint' }]);

    const edit = { type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { editToolCall: { args: { path: '/work/app/a.ts' }, result: { success: { diffString: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' } } } } };
    expect(translateCursorToolCall({ ...edit, subtype: 'started' }, denied)).toMatchObject({ tool: 'Edit', summary: 'Edit a.ts', step: 'edit' });
    expect(translateCursorToolCall(edit, denied)).toMatchObject({ type: 'tool_result', isError: false, output: { added: 1, removed: 1 } });
    const read = { type: 'tool_call', subtype: 'completed', call_id: 'c3', tool_call: { readToolCall: { args: { path: '/work/app/b.ts' }, result: { success: { totalLines: 120 } } } } };
    expect(translateCursorToolCall(read, denied)).toMatchObject({ output: { text: 'Read 120 lines' } });
    expect(translateCursorToolCall({ type: 'tool_call', subtype: 'started', tool_call: { grepToolCall: { args: { pattern: 'TODO' } } } }, denied)).toMatchObject({ tool: 'Grep', step: 'search', target: 'TODO' });
  });
});

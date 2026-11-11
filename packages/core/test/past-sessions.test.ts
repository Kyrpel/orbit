import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyResult, type AgentRunRequest, type AgentRuntime } from '@orbit/agents';
import { createOrbit, MemorySecretStore, PastSessions, pastRefs, silentLogger, type Orbit } from '../src';
import { cleanup, makeRepo, tempDir } from './helpers';

/*
  Your Claude Code and Codex sessions from outside Orbit: read from the CLIs' own files
  (here: fixtures in both formats), condensed into transcripts, searchable, and handed to
  session agents.
*/

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A Claude Code session file, as `claude` writes it in a terminal. */
function claudeSession(dir: string, folder: string, id: string, opts: { cwd: string; title?: string; entrypoint?: string; first?: string; at?: string }) {
  const at = opts.at ?? '2026-11-07T10:00:00.000Z';
  const base = { sessionId: id, cwd: opts.cwd, entrypoint: opts.entrypoint ?? 'cli', isSidechain: false };
  const rows = [
    ...(opts.title ? [{ type: 'ai-title', aiTitle: opts.title, sessionId: id }] : []),
    { type: 'permission-mode', permissionMode: 'auto', sessionId: id },
    { ...base, type: 'user', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content: opts.first ?? 'Make name badges from the guest list <system-reminder>internal note</system-reminder>' } },
    { ...base, type: 'user', timestamp: at, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '[Image: source: C:\\tmp\\1.png]' }] } },
    { ...base, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts', signature: 'x' }] } },
    { ...base, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'guests.xlsx' } }] } },
    { ...base, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python make_badges.py --printer QL-800' } }] } },
    { ...base, type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'PRINTED 40 BADGES token=abcdef123456' }] } },
    { ...base, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'C:\\events\\badges\\make_badges.py' } }] } },
    { ...base, isSidechain: true, type: 'user', timestamp: at, message: { role: 'user', content: 'subagent chatter' } },
    { ...base, type: 'assistant', timestamp: '2026-11-07T10:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Printed 40 badges in Montserrat 18pt. Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz stays out.' }] } },
    { ...base, type: 'user', timestamp: '2026-11-07T10:06:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
    { ...base, type: 'user', timestamp: '2026-11-07T10:07:00.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'a background task finished' } },
  ];
  mkdirSync(path.join(dir, folder), { recursive: true });
  const file = path.join(dir, folder, `${id}.jsonl`);
  writeFileSync(file, jsonl(rows));
  return file;
}

/** A Codex session file (`~/.codex/sessions/YYYY/MM/DD/rollout-…`). */
function codexSession(dir: string, id: string, opts: { cwd: string; originator?: string; request?: string; at?: string }) {
  const at = opts.at ?? '2026-11-08T17:30:00.000Z';
  const item = (it: unknown) => ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: it } });
  const rows = [
    { timestamp: at, type: 'session_meta', payload: { id, cwd: opts.cwd, originator: opts.originator ?? 'Codex Desktop', source: 'vscode' } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex…' }] } },
    item({ type: 'UserMessage', content: [{ type: 'text', text: opts.request ?? '# Files mentioned by the user:\n\n## shot.png: C:/tmp/shot.png\n\n## My request:\nAdd the font files for the headline' }] }),
    item({ type: 'Reasoning', summary_text: [], raw_content: [] }),
    item({ type: 'CommandExecution', command: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', 'Get-ChildItem public/fonts'], status: 'completed', aggregated_output: 'LOTS OF OUTPUT' }),
    item({ type: 'FileChange', changes: { 'C:\\site\\public\\fonts\\inter.woff2': { type: 'add' } }, status: 'completed' }),
    item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Added Inter to public/fonts and wired it in globals.css.' }], phase: 'final' }),
  ];
  const day = path.join(dir, '2026', '11', '08');
  mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-11-08T17-30-00-${id}.jsonl`);
  writeFileSync(file, jsonl(rows));
  return file;
}

describe('past sessions: reading your Claude Code and Codex history', () => {
  let root: string;
  afterEach(() => cleanup(root));

  function setup(own: string[] = []) {
    root = tempDir();
    const claude = path.join(root, 'claude-projects');
    const codex = path.join(root, 'codex-sessions');
    const index = path.join(root, 'session_index.jsonl');
    const library = path.join(root, 'library');
    const past = new PastSessions({ claude, codex, codexIndex: index }, library, () => new Set(own), () => [path.join(root, 'orbit-worktrees')]);
    return { claude, codex, index, library, past };
  }

  it('condenses your sessions: your words, answers, commands and changed files, never output or thinking', async () => {
    const { claude, codex, index, library, past } = setup();
    const events = path.join(root, 'events');
    claudeSession(claude, 'C--events', 'aaaa1111-0000-4000-8000-000000000001', { cwd: events, title: 'VIP name badges' });
    codexSession(codex, 'bbbb2222-0000-4000-8000-000000000002', { cwd: path.join(root, 'site') });
    writeFileSync(index, jsonl([{ id: 'bbbb2222-0000-4000-8000-000000000002', thread_name: 'Add font files' }]));
    await past.sync(true);

    const list = past.list();
    expect(list.map((s) => s.title).sort()).toEqual(['Add font files', 'VIP name badges']);
    const badges = list.find((s) => s.source === 'claude')!;
    expect(badges).toMatchObject({ ref: 'claude/aaaa1111', cwd: events, firstMessage: 'Make name badges from the guest list' });
    // You (2) and the agent's answer (1); the slash command counts as one of your messages.
    expect(badges.messages).toBe(3);

    const md = readFileSync(badges.file!, 'utf8');
    expect(md).toContain('# VIP name badges');
    expect(md).toContain(`- Folder: ${events}`);
    expect(md).toContain('claude --resume aaaa1111-0000-4000-8000-000000000001');
    expect(md).toContain('Make name badges from the guest list');
    expect(md).toContain('- Ran `python make_badges.py --printer QL-800`');
    expect(md).toContain('- Changed C:\\events\\badges\\make_badges.py');
    expect(md).toContain('Printed 40 badges in Montserrat 18pt.');
    expect(md).toContain('/model opus');
    // Left out: tool output, thinking, reminders, image notes, reads, subagents, background notices.
    for (const gone of ['PRINTED 40 BADGES', 'secret thoughts', 'internal note', '[Image: source', 'guests.xlsx', 'subagent chatter', 'background task']) expect(md).not.toContain(gone);
    expect(md).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(md).toContain('[REDACTED ANTHROPIC KEY]');

    const fonts = readFileSync(list.find((s) => s.source === 'codex')!.file!, 'utf8');
    expect(fonts).toContain('Add the font files for the headline\n[attached: shot.png]');
    expect(fonts).not.toContain('## My request');
    expect(fonts).toContain('- Ran `Get-ChildItem public/fonts`');
    expect(fonts).toContain('- Changed C:\\site\\public\\fonts\\inter.woff2');
    expect(fonts).toContain('Added Inter to public/fonts');
    expect(fonts).not.toContain('LOTS OF OUTPUT');
    expect(fonts).toContain('codex resume bbbb2222');

    const idx = readFileSync(path.join(library, 'INDEX.md'), 'utf8');
    expect(idx).toContain('"VIP name badges"');
    expect(idx).toContain('@past:claude/aaaa1111');
    expect(idx).toContain('Codex');
  });

  it('scrubs secrets from titles and first requests too: the index, the picker and prompts never show them', async () => {
    const { claude, library, past } = setup();
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    claudeSession(claude, 'C--k', '77777777-0000-4000-8000-000000000007', { cwd: path.join(root, 'k'), title: `Rotate ${key}`, first: `use this key ${key} for the deploy` });
    await past.sync(true);
    const [s] = past.list();
    expect(s?.title).not.toContain(key);
    expect(s?.firstMessage).not.toContain(key);
    expect(s?.firstMessage).toContain('[REDACTED ANTHROPIC KEY]');
    expect(readFileSync(path.join(library, 'INDEX.md'), 'utf8')).not.toContain(key);
    expect(readFileSync(path.join(library, 'manifest.json'), 'utf8')).not.toContain(key);
  });

  it("leaves out Orbit's own runs, scripts, worktrees and sessions without a word from you", async () => {
    const { claude, codex, past } = setup(['cccc3333-0000-4000-8000-000000000003']);
    const proj = path.join(root, 'shop');
    claudeSession(claude, 'C--shop', 'dddd4444-0000-4000-8000-000000000004', { cwd: proj, title: 'Yours' });
    claudeSession(claude, 'C--shop', 'cccc3333-0000-4000-8000-000000000003', { cwd: proj, title: 'Known to Orbit' });
    claudeSession(claude, 'C--shop', 'eeee5555-0000-4000-8000-000000000005', { cwd: proj, title: 'Headless', entrypoint: 'sdk-cli' });
    claudeSession(claude, 'C--shop', 'ffff6666-0000-4000-8000-000000000006', { cwd: proj, title: 'Orbit prompt', first: 'Project: shop\nFolder: C:\\shop\n\n## The developer says\nhi' });
    claudeSession(claude, 'C--wt', 'abab7777-0000-4000-8000-000000000007', { cwd: path.join(root, 'orbit-worktrees', 'shop-1'), title: 'Mission worktree' });
    codexSession(codex, 'cdcd8888-0000-4000-8000-000000000008', { cwd: proj, originator: 'orbit' });
    codexSession(codex, 'efef9999-0000-4000-8000-000000000009', { cwd: proj, request: '<orbit_role_instructions>\nYou are working…\n</orbit_role_instructions>\nfix it' });
    await past.sync(true);
    expect(past.list().map((s) => s.title)).toEqual(['Yours']);
    expect(past.resolve('claude/cccc3333')).toBeNull();
  });

  it('finds sessions by what was said in them, best matches first, and resolves @past references', async () => {
    const { claude, past } = setup();
    const a = path.join(root, 'a');
    claudeSession(claude, 'C--a', '11111111-0000-4000-8000-000000000001', { cwd: a, title: 'Invoice for a client', first: 'fix the invoice for the chess club', at: '2026-11-09T10:00:00.000Z' });
    claudeSession(claude, 'C--a', '22222222-0000-4000-8000-000000000002', { cwd: a, title: 'Chess name cards', first: 'cards for the chess players', at: '2026-11-01T10:00:00.000Z' });
    claudeSession(claude, 'C--b', '33333333-0000-4000-8000-000000000003', { cwd: path.join(root, 'b'), title: 'Newsletter', first: 'weekly newsletter', at: '2026-11-10T10:00:00.000Z' });
    await past.sync(true);

    // A title match beats a newer session that only mentions the word in passing.
    expect(past.list({ query: 'chess' }).map((s) => s.title)).toEqual(['Chess name cards', 'Invoice for a client']);
    expect(past.list({ query: 'chess cards' }).map((s) => s.title)).toEqual(['Chess name cards']);
    // Words said inside the session count too.
    expect(past.list({ query: 'make_badges.py printer' })).toHaveLength(3);
    expect(past.list({ query: 'montserrat' })).toHaveLength(3);
    expect(past.list({ query: 'nothing like this' })).toEqual([]);
    // A folder's sessions come first; folderOnly keeps only them.
    expect(past.list({ cwd: a }).map((s) => s.title)).toEqual(['Invoice for a client', 'Chess name cards', 'Newsletter']);
    expect(past.list({ cwd: a, folderOnly: true })).toHaveLength(2);

    const hit = past.resolve('claude/22222222');
    expect(hit?.session.title).toBe('Chess name cards');
    expect(hit?.transcript).toContain('cards for the chess players');
    expect(past.resolve('codex/22222222')).toBeNull();
    expect(past.resolve('claude/99999999')).toBeNull();
    expect(pastRefs('look at @past:claude/22222222 and @past:CODEX/abcdef12, again @past:claude/22222222')).toEqual(['claude/22222222', 'codex/abcdef12']);
  });

  it('keeps up: changed files are read again, deleted ones go, and a transcript an agent changed is rewritten', async () => {
    const { claude, library, past } = setup();
    const file = claudeSession(claude, 'C--a', '44444444-0000-4000-8000-000000000004', { cwd: path.join(root, 'a'), title: 'First title' });
    claudeSession(claude, 'C--b', '55555555-0000-4000-8000-000000000005', { cwd: path.join(root, 'b'), title: 'Other' });
    await past.sync(true);
    expect(past.list()).toHaveLength(2);

    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'ai-title', aiTitle: 'Renamed', sessionId: '44444444-0000-4000-8000-000000000004' }) + '\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    await past.sync(true);
    expect(past.list().map((s) => s.title).sort()).toEqual(['Other', 'Renamed']);

    const other = past.list().find((s) => s.title === 'Other')!;
    writeFileSync(other.file!, 'tampered');
    utimesSync(other.file!, later, later);
    await past.sync(true);
    expect(readFileSync(other.file!, 'utf8')).toContain('# Other');

    rmSync(file);
    await past.sync(true);
    expect(past.list().map((s) => s.title)).toEqual(['Other']);
    expect(readdirSync(library).filter((f) => f.endsWith('.md') && f !== 'INDEX.md')).toHaveLength(1);

    // A fresh start reads the saved manifest instead of every file again.
    const again = new PastSessions({ claude, codex: path.join(root, 'none'), codexIndex: path.join(root, 'none.jsonl') }, library, () => new Set(), () => []);
    expect(again.list().map((s) => s.title)).toEqual(['Other']);
  });

  it('lists a session once when Claude Code keeps it in two folders', async () => {
    const { claude, past } = setup();
    claudeSession(claude, 'C--old', '66666666-0000-4000-8000-000000000006', { cwd: path.join(root, 'old'), title: 'Moved', at: '2026-11-01T10:00:00.000Z' });
    claudeSession(claude, 'C--new', '66666666-0000-4000-8000-000000000006', { cwd: path.join(root, 'new'), title: 'Moved', at: '2026-11-05T10:00:00.000Z' });
    await past.sync(true);
    const list = past.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.cwd).toBe(path.join(root, 'new'));
    expect(existsSync(list[0]!.file!)).toBe(true);
    expect(statSync(list[0]!.file!).size).toBeGreaterThan(0);
  });
});

describe('past sessions in Orbit: session agents can use them', () => {
  let root: string;
  let orbit: Orbit;
  afterEach(async () => {
    await orbit.stop();
    orbit.close();
    cleanup(root);
  });

  async function setup() {
    root = tempDir();
    const calls: AgentRunRequest[] = [];
    const runtime: AgentRuntime = {
      id: 'claude-code-cli',
      displayName: 'Claude',
      kind: 'ai',
      resumable: true,
      checkAvailability: async () => ({ available: true, reason: null, sandbox: 'unknown', details: {} }),
      run: async (req) => {
        calls.push(req);
        return emptyResult({ status: 'succeeded', durationMs: 5, numTurns: 1, sessionId: `orbit-run-${calls.length}`, text: 'ok' });
      },
    };
    const claude = path.join(root, 'claude-projects');
    const env = { ...process.env, ORBIT_CLAUDE_PROJECTS_DIR: claude, ORBIT_CODEX_SESSIONS_DIR: path.join(root, 'codex'), ORBIT_CODEX_SESSION_INDEX: path.join(root, 'idx.jsonl') };
    orbit = createOrbit({ home: path.join(root, 'home'), dbFile: ':memory:', runtimes: [runtime], secrets: new MemorySecretStore(), logger: silentLogger, platform: 'linux', env });
    orbit.ctx.settings.update({ execution: { suggestNext: false } });
    const { repoPath } = await makeRepo(root, 'events-app');
    const repo = await orbit.repos.register(repoPath);
    claudeSession(claude, 'C--events-app', 'aaaa1111-0000-4000-8000-000000000001', { cwd: repoPath, title: 'VIP name badges' });
    claudeSession(claude, 'C--elsewhere', 'bbbb2222-0000-4000-8000-000000000002', { cwd: path.join(root, 'marketing'), title: 'Newsletter for the festival', first: 'write the festival newsletter' });
    return { calls, repo, library: orbit.ctx.paths.pastSessions };
  }

  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('tells the agent where your sessions are, lists this folder’s, and sends the one you point at', async () => {
    const { calls, repo, library } = await setup();
    const s = orbit.chat.start({ message: 'Do it like in @past:claude/bbbb2222 please', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    const req = calls[0]!;
    expect(req.readRoots).toContain(library);
    expect(req.systemAppend).toContain(library);
    expect(req.systemAppend).toContain('INDEX.md');
    // This project's own outside sessions, for the first message.
    expect(req.prompt).toContain('Your latest sessions in this folder outside Orbit');
    expect(req.prompt).toContain('"VIP name badges" (@past:claude/aaaa1111)');
    expect(req.prompt).not.toContain('"Newsletter for the festival" (@past');
    // The one you pointed at travels with the message, from any folder.
    expect(req.prompt).toContain('Earlier session the developer points to (@past:claude/bbbb2222)');
    expect(req.prompt).toContain('write the festival newsletter');
    expect(req.prompt).toContain('Do it like in @past:claude/bbbb2222 please');
    const detail = orbit.chat.detail(s.id);
    expect(detail.events.some((e) => e.title.includes('Gave the agent your Claude Code session "Newsletter for the festival"'))).toBe(true);
    // The message you see keeps the reference as you wrote it.
    expect(detail.messages[0]?.content).toBe('Do it like in @past:claude/bbbb2222 please');

    // The API lists them, this project's first, with the project they belong to.
    const listed = await orbit.pastSessions({ repoId: repo.id });
    expect(listed.enabled).toBe(true);
    expect(listed.sessions.map((x) => [x.title, x.repoId])).toEqual([
      ['VIP name badges', repo.id],
      ['Newsletter for the festival', null],
    ]);
    expect((await orbit.pastSessions({ q: 'festival' })).sessions.map((x) => x.title)).toEqual(['Newsletter for the festival']);
  });

  it('says so when a reference points nowhere, and stays out of security checks', async () => {
    const { calls, repo } = await setup();
    const s = orbit.chat.start({ message: 'see @past:claude/deadbeef', repoIds: [repo.id], mode: 'ask' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(orbit.chat.detail(s.id).events.some((e) => e.title.startsWith('Could not find the session @past:claude/deadbeef'))).toBe(true);
    expect(calls[0]?.prompt).not.toContain('Earlier session the developer points to');
    // Read-only questions get the folder too.
    expect(calls[0]?.readRoots).toContain(orbit.ctx.paths.pastSessions);

    // A security check reviews only the change in front of it.
    writeFileSync(path.join(repo.localPath, 'new.js'), 'export const x = 1;\n');
    const check = await orbit.chat.securityCheck(repo.id);
    await until(() => !orbit.chat.isRunning(check.id));
    const sec = calls[calls.length - 1]!;
    expect(sec.role).toBe('security');
    expect(sec.readRoots).not.toContain(orbit.ctx.paths.pastSessions);
    expect(sec.systemAppend).not.toContain('INDEX.md');
  });

  it('turned off in Settings: nothing is read, listed or sent', async () => {
    const { calls, repo, library } = await setup();
    orbit.ctx.settings.update({ execution: { pastSessions: false } });
    const s = orbit.chat.start({ message: 'like @past:claude/bbbb2222', repoIds: [repo.id], mode: 'edit' });
    await until(() => !orbit.chat.isRunning(s.id));
    expect(calls[0]?.readRoots).not.toContain(library);
    expect(calls[0]?.systemAppend).not.toContain('INDEX.md');
    expect(calls[0]?.prompt).not.toContain('Earlier session the developer points to');
    expect(await orbit.pastSessions()).toEqual({ enabled: false, sessions: [], indexing: false });
  });
});

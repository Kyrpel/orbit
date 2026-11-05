import { accessSync, constants } from 'node:fs';
import { integrations, repos } from '@orbit/database';
import { ORBIT_VERSION, type DoctorCheck, type DoctorReport, type RuntimeStatusDTO } from '@orbit/shared';
import type { OrbitContext } from './context';
import { resolveRuntime } from './runtimes';

function nodeVersionOk(v: string): boolean {
  const [maj, min] = v.replace(/^v/, '').split('.').map(Number) as [number, number];
  return maj > 22 || (maj === 22 && min >= 11);
}

/** Dependency diagnostics shown by `orbit doctor` and the first-run wizard. */
export async function runDoctor(ctx: OrbitContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const settings = ctx.settings.get();

  checks.push(
    nodeVersionOk(process.version)
      ? { id: 'node', label: 'Node.js', status: 'ok', detail: process.version }
      : { id: 'node', label: 'Node.js', status: 'error', detail: `${process.version} is too old`, fix: 'Install Node.js 22.11 or newer (24 LTS recommended).' },
  );

  const gitVersion = await ctx.git.version();
  if (!gitVersion) {
    checks.push({ id: 'git', label: 'Git', status: 'error', detail: 'git was not found on PATH.', fix: 'Install Git from https://git-scm.com.' });
  } else {
    checks.push({ id: 'git', label: 'Git', status: 'ok', detail: `git ${gitVersion}` });
    const ident = await ctx.git.identity(ctx.paths.home);
    checks.push(
      ident.name && ident.email
        ? { id: 'git-identity', label: 'Git identity', status: 'ok', detail: `Commits will be authored as ${ident.name}` }
        : {
            id: 'git-identity',
            label: 'Git identity',
            status: 'warn',
            detail: 'user.name or user.email is not set.',
            fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com',
          },
    );
  }

  const gh = await ctx.github.authStatus().catch(() => null);
  if (!gh || !gh.installed) {
    checks.push({ id: 'gh', label: 'GitHub CLI', status: 'warn', detail: 'gh is not installed. Orbit can still run local missions.', fix: 'Install from https://cli.github.com, then run gh auth login.' });
  } else if (!gh.loggedIn) {
    checks.push({ id: 'gh', label: 'GitHub CLI', status: 'warn', detail: `gh ${gh.version ?? ''} is installed but not logged in.`, fix: 'Run gh auth login.' });
  } else {
    const repoScope = gh.scopes.length === 0 || gh.scopes.includes('repo') || gh.scopes.includes('public_repo');
    checks.push({
      id: 'gh',
      label: 'GitHub CLI',
      status: repoScope ? 'ok' : 'warn',
      detail: `Logged in as ${gh.account ?? 'unknown'}${gh.scopes.length ? ` (scopes: ${gh.scopes.join(', ')})` : ''}`,
      ...(repoScope ? {} : { fix: 'Run gh auth refresh -s repo so Orbit can open pull requests.' }),
    });
  }

  const runtimes: RuntimeStatusDTO[] = [];
  for (const rt of ctx.runtimes.values()) {
    const a = await rt.checkAvailability().catch((err: Error) => ({ available: false, reason: err.message, sandbox: 'unknown' as const, details: {} }));
    runtimes.push({ id: rt.id, displayName: rt.displayName, kind: rt.kind, available: a.available, reason: a.reason, sandbox: a.sandbox, details: a.details });
  }
  const auto = settings.execution.runtime === 'auto';
  const resolved = await resolveRuntime(ctx).catch(() => null);
  const active = resolved ? runtimes.find((r) => r.id === resolved.runtime.id) : undefined;
  const prefix = auto ? 'Automatic: ' : '';
  const billing = active?.id === 'claude-code-cli' ? ' (uses your Claude Code plan)' : active?.id === 'claude-agent-sdk' ? ' (billed to your API key)' : '';
  checks.push(
    active?.available
      ? {
          id: 'runtime',
          label: 'Agent runtime',
          status: active.kind === 'scripted' ? 'warn' : 'ok',
          detail: `${prefix}${active.displayName}${billing}${active.kind === 'scripted' ? ', scripted changes only, no AI' : ''}`,
        }
      : {
          id: 'runtime',
          label: 'Agent runtime',
          status: 'error',
          detail: `${prefix}${active?.displayName ?? settings.execution.runtime}: ${resolved?.availability.reason ?? active?.reason ?? 'not available'}`,
          fix: auto
            ? 'Install Claude Code and sign in once by running `claude`, or set ANTHROPIC_API_KEY before starting Orbit.'
            : runtimes.find((r) => r.kind === 'ai' && r.available)
              ? 'Switch the runtime to Automatic in Settings.'
              : 'Install Claude Code and sign in, or set ANTHROPIC_API_KEY (or Bedrock / Vertex / Foundry credentials) and restart Orbit.',
        },
  );

  const codex = runtimes.find((r) => r.id === 'codex-cli');
  if (codex && settings.execution.runtime !== 'scripted') {
    checks.push(
      codex.available
        ? { id: 'codex', label: 'Codex (second AI)', status: 'ok', detail: `Ready${codex.details.version ? ` (${codex.details.version})` : ''}. The orchestrator can give it seats and switch to it when Claude hits a usage limit.` }
        : {
            id: 'codex',
            label: 'Codex (second AI, optional)',
            status: 'info',
            detail: codex.reason ?? 'Not connected.',
            fix: 'Optional: install with `npm install -g @openai/codex` and run `codex login` for second-opinion reviews and automatic switching on usage limits.',
          },
    );
  }

  checks.push(
    settings.execution.mode === 'sandbox'
      ? {
          id: 'execution',
          label: 'Execution mode',
          status: 'info',
          detail: `Sandbox: agent commands must run in Claude Code's OS sandbox (${process.platform}). If the sandbox cannot start, missions stop with an explanation.`,
        }
      : settings.execution.localExecutionConsentAt
        ? { id: 'execution', label: 'Execution mode', status: 'warn', detail: 'Trusted-local: agents run on this machine with your permissions (consent given). This is not a sandbox.' }
        : { id: 'execution', label: 'Execution mode', status: 'error', detail: 'Trusted-local mode is selected but consent was not given.', fix: 'Give consent in Settings → Execution or switch back to sandbox mode.' },
  );
  checks.push(
    settings.execution.localExecutionConsentAt
      ? { id: 'consent', label: 'Local commands', status: 'ok', detail: 'Setup and verification commands may run in mission worktrees.' }
      : {
          id: 'consent',
          label: 'Local commands',
          status: 'warn',
          detail: 'Setup and verification commands will not run until you allow local command execution.',
          fix: 'Allow it in Settings → Execution (they run your repository scripts against agent-written code).',
        },
  );

  try {
    accessSync(ctx.paths.home, constants.W_OK);
    checks.push({ id: 'home', label: 'Orbit data folder', status: 'ok', detail: ctx.paths.home });
  } catch {
    checks.push({ id: 'home', label: 'Orbit data folder', status: 'error', detail: `${ctx.paths.home} is not writable.`, fix: 'Fix permissions or set ORBIT_HOME to another folder.' });
  }

  const repoCount = ctx.db.select({ id: repos.id }).from(repos).all().length;
  checks.push({
    id: 'repos',
    label: 'Repositories',
    status: repoCount ? 'ok' : 'info',
    detail: repoCount ? `${repoCount} connected` : 'None connected yet.',
    ...(repoCount ? {} : { fix: 'Run orbit repo add <path> or use the setup wizard.' }),
  });
  const ints = ctx.db.select().from(integrations).all();
  const asana = ints.filter((i) => i.provider === 'asana');
  checks.push(
    asana.length === 0
      ? { id: 'asana', label: 'Asana', status: 'info', detail: 'Not connected (optional).' }
      : asana.every((i) => i.status === 'connected')
        ? { id: 'asana', label: 'Asana', status: 'ok', detail: `Connected as ${asana.map((i) => i.accountName ?? i.accountUserId).join(', ')}` }
        : { id: 'asana', label: 'Asana', status: 'error', detail: asana.map((i) => i.statusMessage ?? i.status).join('; '), fix: 'Reconnect Asana with a new personal access token.' },
  );

  const runtimeReady = !!active?.available;
  return {
    version: ORBIT_VERSION,
    orbitHome: ctx.paths.home,
    platform: `${process.platform}-${process.arch}`,
    checks,
    runtimes,
    ready: {
      localMissions: !!gitVersion && runtimeReady,
      githubPullRequests: !!gh?.loggedIn,
      asana: asana.some((i) => i.status === 'connected'),
      ai: runtimeReady && active?.kind === 'ai',
    },
  };
}

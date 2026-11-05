#!/usr/bin/env node
import { Command } from 'commander';
import { execa } from 'execa';
import { OrbitClient, OrbitClientError, discoverServer } from '@orbit/client';
import { createOrbit, silentLogger } from '@orbit/core';
import {
  MISSION_STATE_META,
  ORBIT_VERSION,
  errorMessage,
  formatDuration,
  formatUsd,
  isTerminal,
  needsAttention,
  type DoctorReport,
  type MissionDetailDTO,
  type MissionEventDTO,
  type MissionSummaryDTO,
} from '@orbit/shared';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = c(2);
const bold = c(1);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const amber = (s: string) => (useColor ? `\u001b[38;5;214m${s}\u001b[0m` : s);

function toneColor(status: MissionSummaryDTO['status']) {
  const tone = MISSION_STATE_META[status].tone;
  return tone === 'success' ? green : tone === 'danger' ? red : tone === 'attention' ? yellow : tone === 'active' ? cyan : dim;
}

function client(): OrbitClient {
  return OrbitClient.fromEnvironment('cli');
}

function fail(err: unknown): never {
  if (err instanceof OrbitClientError) {
    console.error(red(`✗ ${err.message}`));
    if (err.hint) console.error(dim(`  ${err.hint}`));
  } else {
    console.error(red(`✗ ${errorMessage(err)}`));
  }
  process.exit(1);
}

async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') await execa('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
    else if (process.platform === 'darwin') await execa('open', [url]);
    else await execa('xdg-open', [url], { detached: true, stdio: 'ignore' });
  } catch {
    /* printing the link is enough */
  }
}

function printMissionLine(m: MissionSummaryDTO): void {
  const meta = MISSION_STATE_META[m.status];
  const repos = m.repos.map((r) => r.name).join(', ');
  console.log(`${toneColor(m.status)(meta.label.padEnd(14))} ${bold(m.id)}  ${m.title}${repos ? dim(`  · ${repos}`) : ''}${m.blockedReason ? red(`  · ${m.blockedReason}`) : ''}`);
}

function printDoctor(report: DoctorReport): void {
  console.log(`${amber('◉ Orbit')} ${dim(`v${report.version} · ${report.platform}`)}\n`);
  for (const ch of report.checks) {
    const icon = ch.status === 'ok' ? green('✓') : ch.status === 'warn' ? yellow('!') : ch.status === 'error' ? red('✗') : dim('·');
    console.log(`${icon} ${bold(ch.label.padEnd(18))} ${ch.detail}`);
    if (ch.fix && ch.status !== 'ok') console.log(`  ${dim('→')} ${dim(ch.fix)}`);
  }
  console.log(`\n${dim('Runtimes:')}`);
  for (const r of report.runtimes) console.log(`  ${r.available ? green('✓') : dim('·')} ${r.displayName}${r.available ? '' : dim(` — ${r.reason ?? 'unavailable'}`)}`);
  console.log(`\n${dim('Data folder:')} ${report.orbitHome}`);
}

function describeEvent(e: MissionEventDTO): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const who = e.actor.padEnd(9);
  const tone = e.kind === 'error' ? red : e.kind === 'state' ? amber : e.kind === 'tool' || e.kind === 'command' ? dim : (s: string) => s;
  return `${dim(t)} ${dim(who)} ${tone(e.title)}`;
}

async function watchMission(cl: OrbitClient, id: string, untilAttention = true): Promise<MissionDetailDTO> {
  let after = 0;
  for (;;) {
    const events = await cl.events(id, after);
    for (const e of events) {
      console.log(describeEvent(e));
      after = e.id;
    }
    const d = await cl.mission(id);
    if (isTerminal(d.status) || d.status === 'PR_CREATED' || (untilAttention && needsAttention(d.status))) return d;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function printMission(d: MissionDetailDTO, baseUrl: string): void {
  const meta = MISSION_STATE_META[d.status];
  console.log(`${bold(d.title)}  ${toneColor(d.status)(`[${meta.label}]`)}`);
  console.log(dim(`${d.id} · ${d.source.provider}${d.source.url ? ` · ${d.source.url}` : ''} · ${formatUsd(d.costUsd)}`));
  console.log(dim(meta.description));
  if (d.blockedReason) console.log(red(`Blocked: ${d.blockedReason}`));
  if (d.lastError) console.log(red(`Error: ${d.lastError}`));
  if (d.plan) {
    console.log(`\n${bold('Plan')}  ${d.plan.summary}`);
    d.plan.steps.forEach((s, i) => console.log(dim(`  ${i + 1}. ${s}`)));
  }
  for (const mr of d.missionRepos.filter((r) => r.status !== 'excluded')) {
    console.log(`\n${bold(mr.repoName)} ${dim(`[${mr.status}]`)} ${mr.branch ? cyan(mr.branch) : ''}`);
    if (mr.selection?.reason) console.log(dim(`  ${mr.selection.reason}`));
    if (mr.diffStats) console.log(`  ${mr.diffStats.files} files ${green(`+${mr.diffStats.additions}`)} ${red(`−${mr.diffStats.deletions}`)}`);
    if (mr.pr) console.log(`  PR: ${mr.pr.url}`);
    if (mr.lastError) console.log(red(`  ${mr.lastError}`));
  }
  const latest = d.verifications.filter((v) => v.kind === 'verify').reduce((m, v) => Math.max(m, v.iteration), -1);
  const checks = d.verifications.filter((v) => v.kind === 'verify' && v.iteration === latest);
  if (checks.length) {
    console.log(`\n${bold('Checks')}`);
    for (const ch of checks) console.log(`  ${ch.status === 'passed' ? green('✓') : red('✗')} ${ch.label} ${dim(ch.command)} ${dim(formatDuration(ch.durationMs))}`);
  }
  const review = d.reviews[d.reviews.length - 1];
  if (review) {
    console.log(`\n${bold('Review')} ${review.verdict === 'approve' ? green('approve') : yellow('changes requested')}  ${review.summary}`);
    for (const f of review.findings.slice(0, 10)) console.log(`  ${f.severity === 'blocker' || f.severity === 'major' ? red(f.severity) : dim(f.severity)} ${f.title}${f.file ? dim(` (${f.file})`) : ''}`);
  }
  console.log(`\n${dim('Next:')} ${d.allowedActions.join(', ') || '—'}   ${dim(`${baseUrl}/missions/${d.id}`)}`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const program = new Command();
program.name('orbit').description('Orbit: your projects, your AI team. Turn a task into a reviewed pull request.').version(ORBIT_VERSION);

program
  .command('start')
  .description('Start Orbit: API, dashboard, mission workers and Asana polling (localhost only)')
  .option('-p, --port <port>', 'port', (v) => Number(v))
  .option('--host <host>', 'bind address (loopback only unless --allow-remote)')
  .option('--allow-remote', 'allow binding to a non-loopback address (not recommended)')
  .option('--no-open', 'do not open the browser')
  .option('--no-triggers', 'do not poll Asana for /orbit commands')
  .action(async (opts: { port?: number; host?: string; allowRemote?: boolean; open: boolean; triggers: boolean }) => {
    try {
      const existing = discoverServer();
      if (existing) {
        const probe = new OrbitClient(existing.url, existing.token);
        if (await probe.health().then(() => true, () => false)) {
          console.log(`${amber('◉ Orbit')} is already running at ${existing.url}`);
          return;
        }
      }
      const { startServer } = await import('@orbit/server');
      const server = await startServer({
        ...(opts.port ? { port: opts.port } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        allowRemote: !!opts.allowRemote,
        triggers: opts.triggers,
      });
      console.log(`${amber('◉ Orbit')} ${dim(`v${ORBIT_VERSION}`)} running at ${bold(server.url)}`);
      console.log(`${dim('Sign in:')} ${server.loginUrl}`);
      console.log(dim(`Data: ${server.orbit.ctx.paths.home} · Ctrl+C to stop`));
      if (opts.open) await openBrowser(server.loginUrl);
      const shutdown = async () => {
        console.log(dim('\nStopping Orbit…'));
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    } catch (err) {
      fail(err);
    }
  });

program
  .command('open')
  .description('Open the dashboard in your browser (signed in)')
  .action(async () => {
    const info = discoverServer();
    if (!info) fail(new Error('Orbit is not running. Start it with `orbit start`.'));
    const url = `${info.url}/auth?token=${encodeURIComponent(info.token)}`;
    console.log(url);
    await openBrowser(url);
  });

program
  .command('status')
  .description('Show whether Orbit is running and what needs your attention')
  .action(async () => {
    try {
      const cl = client();
      await cl.health();
      const o = await cl.overview();
      console.log(`${amber('◉ Orbit')} running at ${cl.baseUrl}`);
      console.log(dim(`${o.counts.repos} repos · ${o.counts.projects} projects · ${o.counts.activeMissions} active · ${o.counts.attention} need you · ${o.counts.prsOpened} PRs opened`));
      if (o.attention.length) {
        console.log(`\n${bold('Needs your attention')}`);
        o.attention.forEach(printMissionLine);
      }
      if (o.active.length) {
        console.log(`\n${bold('In progress')}`);
        o.active.forEach(printMissionLine);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('doctor')
  .description('Check git, GitHub CLI, Claude credentials, sandboxing and Orbit data')
  .action(async () => {
    try {
      const info = discoverServer();
      if (info) {
        const cl = new OrbitClient(info.url, info.token);
        if (await cl.health().then(() => true, () => false)) {
          printDoctor(await cl.doctor());
          return;
        }
      }
      const orbit = createOrbit({ logger: silentLogger });
      printDoctor(await orbit.doctor());
      orbit.close();
    } catch (err) {
      fail(err);
    }
  });

const repo = program.command('repo').description('Manage repositories Orbit may work on');
repo
  .command('add <path>')
  .description('Connect a local git repository (nothing in it is modified)')
  .option('--name <name>', 'display name')
  .action(async (repoPath: string, opts: { name?: string }) => {
    try {
      const info = discoverServer();
      const live = info ? await new OrbitClient(info.url, info.token).health().then(() => true, () => false) : false;
      const r = live
        ? await client().addRepo(repoPath, opts.name ? { name: opts.name } : {})
        : await (async () => {
            const orbit = createOrbit({ logger: silentLogger });
            try {
              return await orbit.repos.register(repoPath, opts.name ? { name: opts.name } : {});
            } finally {
              orbit.close();
            }
          })();
      console.log(`${green('✓')} Connected ${bold(r.name)} ${dim(r.localPath)}`);
      console.log(dim(`  default branch ${r.defaultBranch}${r.github ? ` · github ${r.github.owner}/${r.github.repo}` : ' · no GitHub remote'}`));
      if (r.verifyCommands.length) console.log(dim(`  checks: ${r.verifyCommands.map((x) => x.command).join(' · ')}`));
      else console.log(yellow('  No checks detected. Add verification commands in the dashboard → Projects.'));
    } catch (err) {
      fail(err);
    }
  });
repo
  .command('list')
  .description('List connected repositories')
  .action(async () => {
    try {
      const list = await client().repos();
      if (!list.length) console.log(dim('No repositories yet. Run `orbit repo add <path>`.'));
      for (const r of list) console.log(`${bold(r.name.padEnd(24))} ${dim(r.id)} ${r.localPath}${r.allowModify ? '' : yellow(' [read-only]')}`);
    } catch (err) {
      fail(err);
    }
  });
repo
  .command('remove <idOrName>')
  .description('Disconnect a repository (files are not touched)')
  .action(async (ref: string) => {
    try {
      const cl = client();
      const r = (await cl.repos()).find((x) => x.id === ref || x.name === ref);
      if (!r) fail(new Error(`No repository ${ref}`));
      await cl.removeRepo(r.id);
      console.log(`${green('✓')} Disconnected ${r.name}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('run [title...]')
  .description('Run with Orbit: create a mission from a title/description or an Asana task')
  .option('-r, --repo <names...>', 'repositories to change (names or ids)')
  .option('-d, --description <text>', 'requirement details (or pipe them on stdin)')
  .option('--asana <taskGid>', 'run an Asana task instead')
  .option('--project <projectId>', 'Orbit project id for the Asana task')
  .option('-w, --watch', 'follow progress until Orbit needs you')
  .action(async (titleParts: string[], opts: { repo?: string[]; description?: string; asana?: string; project?: string; watch?: boolean }) => {
    try {
      const cl = client();
      const repos = await cl.repos();
      const repoIds = (opts.repo ?? []).map((ref) => {
        const r = repos.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
        if (!r) throw new Error(`Unknown repository "${ref}". See \`orbit repo list\`.`);
        return r.id;
      });
      let source: { integrationId: string; taskId: string; projectId?: string | null } | undefined;
      if (opts.asana) {
        const projects = await cl.projects();
        const project = opts.project ? projects.find((p) => p.id === opts.project) : projects[0];
        const integrationId = project?.integrationId ?? (await cl.integrations())[0]?.id;
        if (!integrationId) throw new Error('Connect Asana first (`orbit asana connect`).');
        source = { integrationId, taskId: opts.asana, projectId: project?.id ?? null };
      }
      const description = opts.description ?? (await readStdin());
      const title = titleParts.join(' ').trim();
      if (!source && !title) throw new Error('Give the mission a title, e.g. orbit run "Add rate limiting to the login endpoint" --repo api');
      const r = await cl.createMission({
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(repoIds.length ? { repoIds } : {}),
        ...(source ? { source } : {}),
      });
      console.log(`${green('✓')} ${r.created ? 'Mission created' : 'Already running'}: ${bold(r.mission.id)}  ${dim(`${cl.baseUrl}/missions/${r.mission.id}`)}`);
      if (opts.watch) {
        const d = await watchMission(cl, r.mission.id);
        console.log('');
        printMission(d, cl.baseUrl);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('missions')
  .description('List missions')
  .option('-a, --attention', 'only missions waiting for you')
  .option('--active', 'only missions in progress')
  .action(async (opts: { attention?: boolean; active?: boolean }) => {
    try {
      const list = await client().missions({ ...(opts.attention ? { attention: true } : {}), ...(opts.active ? { active: true } : {}), limit: 50 });
      if (!list.length) console.log(dim('No missions.'));
      list.forEach(printMissionLine);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('mission <id>')
  .description('Show a mission (plan, repositories, checks, review)')
  .option('-w, --watch', 'follow live progress')
  .action(async (id: string, opts: { watch?: boolean }) => {
    try {
      const cl = client();
      const d = opts.watch ? await watchMission(cl, id) : await cl.mission(id);
      printMission(d, cl.baseUrl);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('review <id>')
  .description('Print the real diff of a mission ready for review')
  .action(async (id: string) => {
    try {
      const cl = client();
      const d = await cl.mission(id);
      printMission(d, cl.baseUrl);
      for (const mr of d.missionRepos.filter((r) => r.baseSha)) {
        const diff = await cl.diff(id, mr.id);
        console.log(`\n${bold(`── ${mr.repoName} ──`)}`);
        for (const l of diff.diff.split('\n')) console.log(l.startsWith('+') && !l.startsWith('+++') ? green(l) : l.startsWith('-') && !l.startsWith('---') ? red(l) : l.startsWith('@@') ? cyan(l) : l);
        if (diff.truncated) console.log(yellow('… diff truncated; see the dashboard for the rest'));
      }
    } catch (err) {
      fail(err);
    }
  });

const simple = (name: string, description: string, fn: (cl: OrbitClient, id: string, ...rest: string[]) => Promise<MissionSummaryDTO>) =>
  program
    .command(`${name} <id> [rest...]`)
    .description(description)
    .action(async (id: string, rest: string[]) => {
      try {
        const m = await fn(client(), id, ...rest);
        console.log(`${green('✓')} ${m.id} is now ${toneColor(m.status)(MISSION_STATE_META[m.status].label)}`);
      } catch (err) {
        fail(err);
      }
    });

simple('approve', 'Approve the planned scope so implementation starts', (cl, id) => cl.approveScope(id));
simple('approve-changes', 'Approve reviewed changes: Orbit commits them locally (nothing is pushed)', (cl, id) => cl.approveChanges(id));
simple('request-changes', 'Send the mission back to the engineer with your notes', (cl, id, ...notes) => cl.requestChanges(id, notes.join(' ')));
simple('finish-local', 'Finish without a pull request (keep the local branch)', (cl, id) => cl.finishLocal(id));
simple('cancel', 'Cancel a mission and clean up its worktree', (cl, id, ...reason) => cl.cancel(id, reason.join(' ') || undefined));
simple('retry', 'Retry a blocked or failed mission', (cl, id) => cl.retry(id));
simple('complete', 'Mark a mission with an open PR as complete', (cl, id) => cl.complete(id));

program
  .command('publish <id>')
  .description('Approve publishing: push the branch and open a pull request with your GitHub CLI login')
  .option('--repo <missionRepoId>', 'which repository (for multi-repo missions)')
  .option('--draft', 'open as a draft pull request')
  .action(async (id: string, opts: { repo?: string; draft?: boolean }) => {
    try {
      const cl = client();
      const d = await cl.mission(id);
      const targets = d.missionRepos.filter((r) => r.status === 'changes_approved' && (!opts.repo || r.id === opts.repo || r.repoName === opts.repo));
      if (!targets.length) throw new Error('Nothing is ready to publish. Approve the changes first (`orbit approve-changes`).');
      for (const t of targets) {
        await cl.publish(id, { missionRepoId: t.id, ...(opts.draft ? { draft: true } : {}) });
        console.log(`${green('✓')} Publishing ${t.repoName} (${t.branch})…`);
      }
      const final = await watchMission(cl, id, false).catch(() => null);
      if (final) for (const mr of final.missionRepos.filter((r) => r.pr || r.lastError)) console.log(mr.pr ? `${green('✓')} ${mr.repoName}: ${mr.pr.url}` : red(`✗ ${mr.repoName}: ${mr.lastError}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('receipt <id>')
  .description('Print a mission receipt (use --share for the privacy-safe version)')
  .option('--share', 'shareable version without repo names, task text or code')
  .action(async (id: string, opts: { share?: boolean }) => {
    try {
      const r = await client().receipt(id);
      console.log(opts.share ? r.share.markdown : r.markdown);
    } catch (err) {
      fail(err);
    }
  });

const asana = program.command('asana').description('Asana integration');
asana
  .command('connect')
  .description('Connect Asana with a personal access token (from ORBIT_ASANA_TOKEN or stdin)')
  .action(async () => {
    try {
      const token = process.env.ORBIT_ASANA_TOKEN || (await readStdin());
      if (!token) throw new Error('Provide the token via ORBIT_ASANA_TOKEN or pipe it on stdin. It is never passed as an argument so it stays out of shell history.');
      const i = await client().connectAsana(token);
      console.log(`${green('✓')} Connected Asana as ${bold(i.account.name ?? i.account.id ?? 'unknown')}. Map projects in the dashboard → Projects.`);
    } catch (err) {
      fail(err);
    }
  });
asana
  .command('projects')
  .description('List connected Asana projects and their repositories')
  .action(async () => {
    try {
      const cl = client();
      const [projects, repos] = await Promise.all([cl.projects(), cl.repos()]);
      if (!projects.length) console.log(dim('No projects connected.'));
      for (const p of projects) console.log(`${bold(p.name)} ${dim(p.id)} → ${p.repoIds.map((id) => repos.find((r) => r.id === id)?.name ?? id).join(', ') || yellow('no repos mapped')}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('consent')
  .description('Allow Orbit to run setup/verification commands (and trusted-local agents) on this machine')
  .option('--revoke', 'withdraw consent')
  .action(async (opts: { revoke?: boolean }) => {
    try {
      await client().consent(!opts.revoke);
      console.log(opts.revoke ? `${green('✓')} Consent withdrawn.` : `${green('✓')} Local command execution allowed. Commands run with your user permissions; this is not a sandbox.`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('mcp')
  .description('Run the Orbit MCP server on stdio (for Claude Code: claude mcp add orbit -- orbit mcp)')
  .action(async () => {
    const { runMcpStdio } = await import('@orbit/mcp');
    await runMcpStdio();
  });

program.parseAsync(process.argv).catch(fail);

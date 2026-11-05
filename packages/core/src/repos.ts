import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, inArray, notInArray, missionRepos, missions, projectRepos, repos, type RepoRow } from '@orbit/database';
import { detectCommands, findRepositories, parseGitHubRemote, sanitizeRemoteUrl, summarizeRepository, type GhRepo } from '@orbit/git';
import {
  CommandLineError,
  newId,
  OrbitError,
  parseCommandLine,
  TERMINAL_STATES,
  type CommandSpec,
  type RepoDTO,
  type RepoHealth,
} from '@orbit/shared';
import { audit, nowIso, type OrbitContext } from './context';

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Your home folder or a drive root: never a project. */
export function isHomeOrDriveRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return samePath(resolved, os.homedir()) || path.parse(resolved).root === resolved || samePath(resolved, path.parse(resolved).root);
}

export interface RepoPatch {
  name?: string;
  allowModify?: boolean;
  defaultBranch?: string;
  setupCommands?: CommandSpec[];
  verifyCommands?: CommandSpec[];
}

function validateCommands(list: CommandSpec[] | undefined, label: string): CommandSpec[] | undefined {
  if (!list) return undefined;
  return list.map((c, i) => {
    try {
      parseCommandLine(c.command);
    } catch (err) {
      const msg = err instanceof CommandLineError ? err.message : String(err);
      throw new OrbitError('VALIDATION', `${label} command #${i + 1} (${c.label || c.command}): ${msg}`);
    }
    return {
      id: c.id || newId('cmd', 8),
      label: (c.label || c.command).slice(0, 80),
      command: c.command.trim(),
      timeoutSec: Math.min(Math.max(Math.round(c.timeoutSec || 600), 10), 7200),
      enabled: c.enabled !== false,
      source: c.source === 'detected' ? 'detected' : 'user',
    };
  });
}

export class RepoService {
  constructor(private readonly ctx: OrbitContext) {}

  toDTO(row: RepoRow, projectIds: string[] = []): RepoDTO {
    return {
      id: row.id,
      name: row.name,
      localPath: row.localPath,
      remoteUrl: row.remoteUrl,
      github: row.githubOwner && row.githubRepo ? { owner: row.githubOwner, repo: row.githubRepo } : null,
      defaultBranch: row.defaultBranch,
      allowModify: row.allowModify,
      isGit: row.isGit,
      setupCommands: row.setupCommands ?? [],
      verifyCommands: row.verifyCommands ?? [],
      summary: row.summary ?? null,
      summaryUpdatedAt: row.summaryUpdatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      projectIds,
    };
  }

  private projectIdsByRepo(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const pr of this.ctx.db.select().from(projectRepos).all()) {
      map.set(pr.repoId, [...(map.get(pr.repoId) ?? []), pr.projectId]);
    }
    return map;
  }

  list(): RepoDTO[] {
    const pids = this.projectIdsByRepo();
    return this.ctx.db
      .select()
      .from(repos)
      .orderBy(repos.name)
      .all()
      .map((r) => this.toDTO(r, pids.get(r.id) ?? []));
  }

  getRow(id: string): RepoRow {
    const row = this.ctx.db.select().from(repos).where(eq(repos.id, id)).get();
    if (!row) throw new OrbitError('NOT_FOUND', `Repository ${id} is not connected to Orbit.`);
    return row;
  }

  get(id: string): RepoDTO {
    return this.toDTO(this.getRow(id), this.projectIdsByRepo().get(id) ?? []);
  }

  findByNameOrId(ref: string): RepoRow | null {
    const all = this.ctx.db.select().from(repos).all();
    return all.find((r) => r.id === ref) ?? all.find((r) => r.name.toLowerCase() === ref.toLowerCase()) ?? null;
  }

  /**
   * Connects a project folder. Nothing in it is modified.
   * - A folder that is its own git repository can be changed by missions.
   * - Any other folder is connected read-only: agents may read it as a reference.
   * Orbit never silently connects a parent repository, your home folder or a drive.
   */
  async register(inputPath: string, opts: { name?: string; allowModify?: boolean; actor?: string } = {}): Promise<RepoDTO> {
    const resolved = path.resolve(inputPath.trim().replace(/^["']|["']$/g, ''));
    if (!existsSync(resolved)) throw new OrbitError('VALIDATION', `Folder not found: ${resolved}`);
    if (isHomeOrDriveRoot(resolved)) {
      throw new OrbitError('VALIDATION', 'That is your whole home folder or a drive. Connect individual project folders instead.');
    }
    const top = (await this.ctx.git.isRepo(resolved)) ? await this.ctx.git.topLevel(resolved) : null;
    const ownRepo = top !== null && samePath(top, resolved);
    if (top && !ownRepo && !isHomeOrDriveRoot(top)) {
      throw new OrbitError('VALIDATION', `This folder is inside the git repository at ${top}. Connect that repository instead.`, {
        hint: 'Missions change whole repositories, so Orbit connects repository roots.',
      });
    }
    // Not a repository of its own (or only inside an accidental repository at your home folder):
    // connect it as a read-only folder that missions can read for context.
    if (!ownRepo) return this.registerFolder(resolved, opts);

    const existing = this.ctx.db.select().from(repos).all().find((r) => samePath(r.localPath, top));
    if (existing) throw new OrbitError('CONFLICT', `${existing.name} is already connected.`, { details: { repoId: existing.id } });

    const remote = sanitizeRemoteUrl(await this.ctx.git.remoteUrl(top));
    const gh = parseGitHubRemote(remote);
    const defaultBranch = await this.ctx.git.defaultBranch(top);
    const detected = detectCommands(top);
    const summary = await summarizeRepository(top, this.ctx.git);
    const ts = nowIso(this.ctx);
    const baseName = opts.name?.trim() || gh?.repo || path.basename(top);
    const taken = new Set(this.ctx.db.select({ name: repos.name }).from(repos).all().map((r) => r.name.toLowerCase()));
    let name = baseName;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${baseName}-${i}`;

    const row = this.ctx.db
      .insert(repos)
      .values({
        id: newId('repo'),
        name,
        localPath: top,
        remoteUrl: remote,
        githubOwner: gh?.owner ?? null,
        githubRepo: gh?.repo ?? null,
        defaultBranch,
        allowModify: opts.allowModify ?? true,
        setupCommands: detected.setup,
        verifyCommands: detected.verify,
        summary,
        summaryHeadSha: summary.headSha ?? null,
        summaryUpdatedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
    audit(this.ctx, { actor: opts.actor ?? 'user', action: 'repo.connected', target: row.id, summary: `Connected repository ${name} (${top})` });
    this.ctx.bus.publish({ type: 'repos.updated' });
    return this.toDTO(row);
  }

  private async registerFolder(folder: string, opts: { name?: string; actor?: string }): Promise<RepoDTO> {
    const existing = this.ctx.db.select().from(repos).all().find((r) => samePath(r.localPath, folder));
    if (existing) throw new OrbitError('CONFLICT', `${existing.name} is already connected.`, { details: { repoId: existing.id } });
    const summary = await summarizeRepository(folder, this.ctx.git);
    const ts = nowIso(this.ctx);
    const baseName = opts.name?.trim() || path.basename(folder);
    const taken = new Set(this.ctx.db.select({ name: repos.name }).from(repos).all().map((r) => r.name.toLowerCase()));
    let name = baseName;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${baseName}-${i}`;
    const row = this.ctx.db
      .insert(repos)
      .values({
        id: newId('repo'),
        name,
        localPath: folder,
        remoteUrl: null,
        githubOwner: null,
        githubRepo: null,
        defaultBranch: '',
        allowModify: false,
        isGit: false,
        setupCommands: [],
        verifyCommands: [],
        summary,
        summaryHeadSha: null,
        summaryUpdatedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
    audit(this.ctx, { actor: opts.actor ?? 'user', action: 'repo.connected', target: row.id, summary: `Connected folder ${name} (${folder}) as read-only: it is not a git repository` });
    this.ctx.bus.publish({ type: 'repos.updated' });
    return this.toDTO(row);
  }

  update(id: string, patch: RepoPatch, actor = 'user'): RepoDTO {
    const row = this.getRow(id);
    if (!row.isGit && patch.allowModify) {
      throw new OrbitError('VALIDATION', `${row.name} is a folder without git, so Orbit can only read it.`, {
        hint: 'To let missions change it, run `git init` there, make a first commit, then reconnect it.',
      });
    }
    const setupCommands = validateCommands(patch.setupCommands, 'Setup');
    const verifyCommands = validateCommands(patch.verifyCommands, 'Verification');
    if (patch.name !== undefined && !patch.name.trim()) throw new OrbitError('VALIDATION', 'Name cannot be empty.');
    const next = this.ctx.db
      .update(repos)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.allowModify !== undefined ? { allowModify: patch.allowModify } : {}),
        ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch.trim() } : {}),
        ...(setupCommands ? { setupCommands } : {}),
        ...(verifyCommands ? { verifyCommands } : {}),
        updatedAt: nowIso(this.ctx),
      })
      .where(eq(repos.id, row.id))
      .returning()
      .get();
    audit(this.ctx, { actor, action: 'repo.updated', target: id, summary: `Updated repository ${next?.name ?? row.name}`, details: Object.keys(patch) });
    this.ctx.bus.publish({ type: 'repos.updated' });
    return this.get(id);
  }

  /** Disconnects a repository from Orbit. Files on disk are never touched. */
  remove(id: string, actor = 'user'): void {
    const row = this.getRow(id);
    const active = this.ctx.db
      .select({ id: missions.id })
      .from(missionRepos)
      .innerJoin(missions, eq(missions.id, missionRepos.missionId))
      .where(and(eq(missionRepos.repoId, id), notInArray(missions.status, [...TERMINAL_STATES, 'FAILED'])))
      .all();
    if (active.length) throw new OrbitError('CONFLICT', `${row.name} is used by ${active.length} active mission(s). Finish or cancel them first.`);
    this.ctx.db.delete(repos).where(eq(repos.id, id)).run();
    audit(this.ctx, { actor, action: 'repo.disconnected', target: id, summary: `Disconnected repository ${row.name}` });
    this.ctx.bus.publish({ type: 'repos.updated' });
  }

  async health(id: string): Promise<RepoHealth> {
    const row = this.getRow(id);
    if (!existsSync(row.localPath)) return { exists: false, isGitRepo: false, error: 'Folder no longer exists.' };
    if (!row.isGit) return { exists: true, isGitRepo: false };
    try {
      if (!(await this.ctx.git.isRepo(row.localPath))) return { exists: true, isGitRepo: false, error: 'Not a git repository anymore.' };
      const [branch, sha, clean] = await Promise.all([
        this.ctx.git.currentBranch(row.localPath),
        this.ctx.git.headSha(row.localPath).catch(() => undefined),
        this.ctx.git.isClean(row.localPath).catch(() => undefined),
      ]);
      const h: RepoHealth = { exists: true, isGitRepo: true };
      if (branch) h.currentBranch = branch;
      if (sha) h.headSha = sha;
      if (clean !== undefined) h.clean = clean;
      return h;
    } catch (err) {
      return { exists: true, isGitRepo: false, error: (err as Error).message };
    }
  }

  /** Regenerates the repository summary when HEAD moved (or always with `force`). */
  async refreshSummary(id: string, force = false): Promise<RepoDTO> {
    const row = this.getRow(id);
    const head = row.isGit ? await this.ctx.git.headSha(row.localPath).catch(() => null) : null;
    if (!force && head && head === row.summaryHeadSha && row.summary) return this.get(id);
    // Plain folders have no HEAD to compare; refresh them at most every 10 minutes.
    if (!force && !row.isGit && row.summary && row.summaryUpdatedAt && Date.now() - Date.parse(row.summaryUpdatedAt) < 10 * 60_000) return this.get(id);
    const summary = await summarizeRepository(row.localPath, this.ctx.git);
    this.ctx.db
      .update(repos)
      .set({ summary, summaryHeadSha: summary.headSha ?? null, summaryUpdatedAt: nowIso(this.ctx), updatedAt: nowIso(this.ctx) })
      .where(eq(repos.id, id))
      .run();
    return this.get(id);
  }

  redetectCommands(id: string): { setup: CommandSpec[]; verify: CommandSpec[] } {
    const row = this.getRow(id);
    const d = detectCommands(row.localPath);
    return { setup: d.setup, verify: d.verify };
  }

  /** Shallow scan (the folder itself plus its direct children) for git repositories. */
  async scan(root: string): Promise<{ path: string; name: string; connectedRepoId: string | null }[]> {
    const resolved = path.resolve(root.trim().replace(/^["']|["']$/g, ''));
    if (!existsSync(resolved)) throw new OrbitError('VALIDATION', `Folder not found: ${resolved}`);
    const found = (await findRepositories(resolved, this.ctx.git)).filter((p) => !isHomeOrDriveRoot(p));
    const connected = new Map(this.ctx.db.select().from(repos).all().map((r) => [path.resolve(r.localPath).toLowerCase(), r.id]));
    return found.map((p) => ({ path: p, name: path.basename(p), connectedRepoId: connected.get(p.toLowerCase()) ?? null }));
  }

  async listGitHub(limit = 100): Promise<(GhRepo & { connectedRepoId: string | null })[]> {
    const list = await this.ctx.github.listRepos(limit);
    const connected = new Map(
      this.ctx.db
        .select()
        .from(repos)
        .all()
        .filter((r) => r.githubOwner && r.githubRepo)
        .map((r) => [`${r.githubOwner}/${r.githubRepo}`.toLowerCase(), r.id]),
    );
    return list.map((r) => ({ ...r, connectedRepoId: connected.get(r.nameWithOwner.toLowerCase()) ?? null }));
  }

  /** Clones an explicitly selected GitHub repository into ORBIT_HOME/repos and connects it. */
  async cloneFromGitHub(nameWithOwner: string, actor = 'user'): Promise<RepoDTO> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) throw new OrbitError('VALIDATION', 'Use the owner/repo form.');
    const [owner, name] = nameWithOwner.split('/') as [string, string];
    const dest = path.join(this.ctx.paths.repos, owner, name);
    if (existsSync(dest)) {
      if (await this.ctx.git.isRepo(dest)) return this.register(dest, { actor });
      throw new OrbitError('CONFLICT', `${dest} already exists and is not a git repository.`);
    }
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(dest), { recursive: true });
    await this.ctx.github.cloneRepo(nameWithOwner, dest);
    audit(this.ctx, { actor, action: 'repo.cloned', target: nameWithOwner, summary: `Cloned ${nameWithOwner}` });
    return this.register(dest, { actor });
  }

  rowsByIds(ids: string[]): RepoRow[] {
    if (ids.length === 0) return [];
    return this.ctx.db.select().from(repos).where(inArray(repos.id, ids)).all();
  }
}

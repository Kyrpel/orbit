import type { PullRequestInfo } from '@orbit/shared';
import { defaultRunner, runChecked, type CommandRunner } from './exec';

export interface GhRepo {
  nameWithOwner: string;
  name: string;
  owner: string;
  url: string;
  visibility: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string | null;
  updatedAt: string | null;
}

export interface GhAuthStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  account: string | null;
  host: string | null;
  scopes: string[];
  detail: string;
}

export interface CreatePullRequestInput {
  /** owner/repo */
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}

/** The GitHub operations Orbit needs. Implemented with the user's own `gh` CLI session. */
export interface GitHubClient {
  authStatus(): Promise<GhAuthStatus>;
  listRepos(limit?: number): Promise<GhRepo[]>;
  repoView(nameWithOwner: string): Promise<GhRepo>;
  findPullRequest(nameWithOwner: string, head: string): Promise<PullRequestInfo | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo>;
  viewPullRequest(nameWithOwner: string, numberOrUrl: string | number): Promise<PullRequestInfo>;
  cloneRepo(nameWithOwner: string, dest: string): Promise<void>;
}

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat', CLICOLOR: '0' };

interface RawRepo {
  nameWithOwner: string;
  name: string;
  owner?: { login?: string };
  url: string;
  visibility?: string;
  isPrivate?: boolean;
  description?: string | null;
  defaultBranchRef?: { name?: string } | null;
  updatedAt?: string;
}

function toRepo(r: RawRepo): GhRepo {
  return {
    nameWithOwner: r.nameWithOwner,
    name: r.name,
    owner: r.owner?.login ?? r.nameWithOwner.split('/')[0] ?? '',
    url: r.url,
    visibility: (r.visibility ?? (r.isPrivate ? 'PRIVATE' : 'PUBLIC')).toUpperCase(),
    isPrivate: r.isPrivate ?? r.visibility?.toUpperCase() !== 'PUBLIC',
    description: r.description ?? null,
    defaultBranch: r.defaultBranchRef?.name ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

export class GhCliClient implements GitHubClient {
  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly bin = 'gh',
  ) {}

  private async gh(args: string[], input?: string, timeoutMs = 120_000) {
    return runChecked(this.runner, this.bin, args, { env: GH_ENV, timeoutMs, ...(input !== undefined ? { input } : {}) });
  }

  async authStatus(): Promise<GhAuthStatus> {
    const version = await this.runner.run(this.bin, ['--version'], { env: GH_ENV, timeoutMs: 15_000 });
    if (!version.ok) {
      return { installed: false, version: null, loggedIn: false, account: null, host: null, scopes: [], detail: 'GitHub CLI (gh) is not installed.' };
    }
    const v = /gh version (\S+)/.exec(version.stdout)?.[1] ?? null;
    const status = await this.runner.run(this.bin, ['auth', 'status', '--hostname', 'github.com'], { env: GH_ENV, timeoutMs: 30_000 });
    const text = `${status.stdout}\n${status.stderr}`;
    const account = /Logged in to (\S+) account (\S+)/.exec(text) ?? /Logged in to (\S+) as (\S+)/.exec(text);
    const scopesLine = /Token scopes:\s*(.+)/.exec(text)?.[1] ?? '';
    const scopes = scopesLine
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean);
    return {
      installed: true,
      version: v,
      loggedIn: status.ok && account !== null,
      account: account?.[2] ?? null,
      host: account?.[1] ?? null,
      scopes,
      detail: status.ok ? 'Authenticated with GitHub CLI.' : 'Run `gh auth login` to authenticate.',
    };
  }

  async listRepos(limit = 100): Promise<GhRepo[]> {
    const res = await this.gh([
      'repo',
      'list',
      '--limit',
      String(limit),
      '--json',
      'nameWithOwner,name,owner,url,visibility,isPrivate,description,defaultBranchRef,updatedAt',
    ]);
    return (JSON.parse(res.stdout || '[]') as RawRepo[]).map(toRepo);
  }

  async repoView(nameWithOwner: string): Promise<GhRepo> {
    const res = await this.gh([
      'repo',
      'view',
      nameWithOwner,
      '--json',
      'nameWithOwner,name,owner,url,visibility,isPrivate,description,defaultBranchRef,updatedAt',
    ]);
    return toRepo(JSON.parse(res.stdout) as RawRepo);
  }

  async findPullRequest(nameWithOwner: string, head: string): Promise<PullRequestInfo | null> {
    const res = await this.gh(['pr', 'list', '-R', nameWithOwner, '--head', head, '--state', 'all', '--json', 'number,url,state,title', '--limit', '5']);
    const list = JSON.parse(res.stdout || '[]') as PullRequestInfo[];
    const open = list.find((p) => p.state === 'OPEN');
    return open ?? list[0] ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    const args = ['pr', 'create', '-R', input.repo, '--base', input.base, '--head', input.head, '--title', input.title, '--body-file', '-'];
    if (input.draft) args.push('--draft');
    const res = await this.gh(args, input.body, 180_000);
    const url = /https:\/\/\S+\/pull\/\d+/.exec(res.stdout)?.[0];
    if (!url) throw new Error(`gh pr create did not return a pull request URL: ${res.stdout.slice(0, 300)}`);
    return this.viewPullRequest(input.repo, url);
  }

  async viewPullRequest(nameWithOwner: string, numberOrUrl: string | number): Promise<PullRequestInfo> {
    const res = await this.gh(['pr', 'view', String(numberOrUrl), '-R', nameWithOwner, '--json', 'number,url,state,title']);
    return JSON.parse(res.stdout) as PullRequestInfo;
  }

  async cloneRepo(nameWithOwner: string, dest: string): Promise<void> {
    await this.gh(['repo', 'clone', nameWithOwner, dest], undefined, 900_000);
  }
}

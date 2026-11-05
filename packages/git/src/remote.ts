export interface GitHubRemote {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

/** Recognizes github.com remotes in HTTPS, SSH and scp-like forms. */
export function parseGitHubRemote(url: string | null | undefined): GitHubRemote | null {
  if (!url) return null;
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  ];
  for (const p of patterns) {
    const m = p.exec(trimmed);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2], nameWithOwner: `${m[1]}/${m[2]}` };
  }
  return null;
}

/** Removes credentials embedded in a remote URL before it is stored or displayed. */
export function sanitizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

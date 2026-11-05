import type { RepoRow } from '@orbit/database';

/**
 * Deterministic part of repository routing. It finds textual evidence linking a
 * task to each authorized repository. The score only orders candidates; it is
 * never shown as a confidence value. The planner agent makes the final
 * proposal, and a human confirms whenever routing is ambiguous.
 */
const STOPWORDS = new Set(
  'the and for with that this from into when then than have has had are was were will would should could can cannot not but you your our their them they its it'.split(' ').concat(
    'add fix make use using update change create new old remove page app code task issue bug feature support need needs want also some all any each more most other only same such very just like get set run test tests file files show user users data please able'.split(' '),
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .flatMap((w) => [w, ...w.split(/[-_]/)])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export interface RouteEvidence {
  repoId: string;
  repoName: string;
  score: number;
  evidence: string[];
}

export function scoreRepositories(task: { title: string; body: string; extra?: string | null }, candidates: RepoRow[]): RouteEvidence[] {
  const text = `${task.title}\n${task.body}\n${task.extra ?? ''}`;
  const lower = text.toLowerCase();
  const words = new Set(tokenize(text));
  return candidates
    .map((repo) => {
      const evidence: string[] = [];
      let score = 0;
      const names = new Set([repo.name.toLowerCase(), repo.githubRepo?.toLowerCase(), repo.summary?.name?.toLowerCase()].filter((n): n is string => !!n));
      for (const n of names) {
        if (n.length >= 3 && lower.includes(n)) {
          evidence.push(`The task names the repository "${n}".`);
          score += 10;
          break;
        }
      }
      const keywords = new Set(repo.summary?.keywords ?? []);
      const hits = [...words].filter((w) => keywords.has(w));
      if (hits.length) {
        evidence.push(`Task terms found in this repository's files, docs or dependencies: ${hits.slice(0, 8).join(', ')}.`);
        score += hits.length;
      }
      const frameworks = (repo.summary?.frameworks ?? []).filter((f) => lower.includes(f.toLowerCase()));
      if (frameworks.length) {
        evidence.push(`The task mentions ${frameworks.join(', ')}, which this repository uses.`);
        score += 2 * frameworks.length;
      }
      return { repoId: repo.id, repoName: repo.name, score, evidence };
    })
    .sort((a, b) => b.score - a.score);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Connected projects a task mentions by folder path or name, offered as read-only
 * references (never added without the developer's approval). A mentioned path only
 * matches the project at exactly that folder, not its parent folders.
 */
export function suggestReferences(text: string, repos: RepoRow[], exclude: Set<string>): { repoId: string; repoName: string; reason: string }[] {
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  const hay = norm(text);
  // Names are only matched outside file paths, so "C:/Users/me/Documents/x" does not suggest "me".
  const words = hay.replace(/[a-z]:\/[^\s"'`<>]*|(?:^|\s)\/[^\s"'`<>]+/g, ' ');
  const out: { repoId: string; repoName: string; reason: string }[] = [];
  for (const repo of repos) {
    if (exclude.has(repo.id)) continue;
    const full = norm(repo.localPath);
    const base = full.split('/').pop() ?? '';
    const name = repo.name.toLowerCase();
    if (new RegExp(`${escapeRegExp(full)}(?![/a-z0-9_.-])`).test(hay)) {
      out.push({ repoId: repo.id, repoName: repo.name, reason: `The task mentions its folder (${repo.localPath}).` });
    } else if (name.length >= 5 && new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(name)}($|[^a-z0-9_-])`).test(words)) {
      out.push({ repoId: repo.id, repoName: repo.name, reason: `The task mentions "${repo.name}".` });
    } else if (base.length >= 6 && base !== name && new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(base)}($|[^a-z0-9_-])`).test(words)) {
      out.push({ repoId: repo.id, repoName: repo.name, reason: `The task mentions "${base}".` });
    }
  }
  return out.slice(0, 5);
}

/** Heuristic selection used only when no planner output is available. */
export function heuristicSelection(ranked: RouteEvidence[]): { selected: RouteEvidence[]; ambiguous: boolean; note: string } {
  if (ranked.length === 0) return { selected: [], ambiguous: true, note: 'No authorized repositories.' };
  if (ranked.length === 1) return { selected: ranked, ambiguous: false, note: 'Only one authorized repository.' };
  const [top, second] = ranked as [RouteEvidence, RouteEvidence, ...RouteEvidence[]];
  if (top.score === 0) return { selected: [], ambiguous: true, note: 'No task terms matched any repository. Choose the repositories yourself.' };
  if (second.score >= top.score * 0.75) {
    return { selected: ranked.filter((r) => r.score >= top.score * 0.75), ambiguous: true, note: 'Several repositories match the task similarly. Confirm the scope.' };
  }
  return { selected: [top], ambiguous: false, note: `${top.repoName} matches the task best.` };
}

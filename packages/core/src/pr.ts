import type { ReviewRow, VerificationRow } from '@orbit/database';
import { containsKnownSecret, formatDuration, redactSecrets, truncate, type DiffStats } from '@orbit/shared';

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic API key'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\b[0-9]\/[0-9]{6,}(?:\/[0-9]{6,})?:[A-Za-z0-9]{16,}\b/, 'Asana token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
];

/**
 * Looks for credentials in text that is about to leave the machine (commits,
 * PR bodies). Only added lines of a diff are checked. Returns the kinds found,
 * never the values.
 */
export function scanForSecrets(text: string, mode: 'diff' | 'text' = 'diff'): string[] {
  const added =
    mode === 'text'
      ? text
      : text
          .split(/\r?\n/)
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .join('\n');
  const found = new Set<string>();
  if (containsKnownSecret(added)) found.add('a token Orbit is configured with');
  for (const [re, label] of SECRET_PATTERNS) if (re.test(added)) found.add(label);
  return [...found];
}

const STATUS_ICON: Record<string, string> = { passed: '✅ passed', failed: '❌ failed', timeout: '⏱ timed out', error: '⚠️ could not run', skipped: '➖ skipped', running: '… running' };

export function buildPrDraft(input: {
  missionId: string;
  title: string;
  requirement: string;
  includeRequirement: boolean;
  sourceUrl: string | null;
  sourceProvider: string;
  engineerSummary: string | null;
  planSummary: string | null;
  stats: DiffStats;
  verifications: VerificationRow[];
  review: ReviewRow | null;
}): { title: string; body: string } {
  const latestIteration = input.verifications.reduce((max, v) => Math.max(max, v.iteration), -1);
  const checks = input.verifications.filter((v) => v.iteration === latestIteration);
  const lines: string[] = [];
  lines.push('## Summary', '', input.engineerSummary?.trim() || input.planSummary?.trim() || input.title, '');
  if (input.includeRequirement && input.requirement.trim()) {
    lines.push('<details><summary>Requirement</summary>', '', truncate(input.requirement.trim(), 3000), '', '</details>', '');
  }
  lines.push('## Changes', '');
  for (const f of input.stats.fileList.slice(0, 50)) lines.push(`- \`${f.path}\` (${f.status}, +${f.additions} −${f.deletions})`);
  if (input.stats.fileList.length > 50) lines.push(`- …and ${input.stats.fileList.length - 50} more files`);
  lines.push('', '## Verification', '');
  if (checks.length) {
    lines.push('| Check | Command | Result | Time |', '|---|---|---|---|');
    for (const c of checks) lines.push(`| ${c.label} | \`${c.command.replace(/\|/g, '\\|')}\` | ${STATUS_ICON[c.status] ?? c.status} | ${formatDuration(c.durationMs)} |`);
  } else {
    lines.push('No verification commands are configured for this repository.');
  }
  if (input.review) {
    lines.push('', '## Automated review', '', input.review.summary || (input.review.verdict === 'approve' ? 'No blocking issues found.' : 'Changes were requested.'));
    const open = input.review.findings.filter((f) => f.severity !== 'nit');
    if (open.length) {
      lines.push('');
      for (const f of open.slice(0, 15)) lines.push(`- **${f.severity}** ${f.title}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : ''}`);
    }
  }
  if (input.sourceUrl) lines.push('', `Source task: ${input.sourceUrl}`);
  lines.push('', '---', `Prepared by Orbit · mission \`${input.missionId}\`. Reviewed and approved by a human before publishing.`);
  return { title: truncate(redactSecrets(input.title), 120), body: redactSecrets(lines.join('\n')) };
}

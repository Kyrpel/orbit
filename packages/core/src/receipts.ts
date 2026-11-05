import { formatDuration, formatUsd, MISSION_STATE_META, type MissionDetailDTO, type ReceiptDTO } from '@orbit/shared';

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

function stats(d: MissionDetailDTO) {
  const files = d.missionRepos.reduce((n, r) => n + (r.diffStats?.files ?? 0), 0);
  const additions = d.missionRepos.reduce((n, r) => n + (r.diffStats?.additions ?? 0), 0);
  const deletions = d.missionRepos.reduce((n, r) => n + (r.diffStats?.deletions ?? 0), 0);
  const latest = d.verifications.filter((v) => v.kind === 'verify').reduce((m, v) => Math.max(m, v.iteration), -1);
  const checks = d.verifications.filter((v) => v.kind === 'verify' && v.iteration === latest);
  const passed = checks.filter((c) => c.status === 'passed').length;
  const lastReview = d.reviews[d.reviews.length - 1];
  const blocking = lastReview ? lastReview.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').length : 0;
  const prs = d.missionRepos.filter((r) => r.pr).length;
  const start = Date.parse(d.startedAt ?? d.createdAt);
  const end = Date.parse(d.completedAt ?? d.updatedAt);
  const repos = d.missionRepos.filter((r) => !['excluded', 'discarded', 'proposed'].includes(r.status)).length;
  return { files, additions, deletions, checks: checks.length, passed, blocking, prs, durationMs: end - start, repos, findings: lastReview?.findings.length ?? 0 };
}

/**
 * A mission receipt. The private version is for you. The share version leaves
 * out repository names, task content, people and code by default.
 */
export function buildReceipt(d: MissionDetailDTO): ReceiptDTO {
  const s = stats(d);
  const meta = MISSION_STATE_META[d.status];
  const priv: string[] = [
    `# Mission receipt: ${d.title}`,
    '',
    `- Status: ${meta.label}`,
    `- Source: ${d.source.provider}${d.source.url ? ` (${d.source.url})` : ''}`,
    `- Repositories: ${d.missionRepos.filter((r) => !['excluded', 'discarded'].includes(r.status)).map((r) => r.repoName).join(', ') || '—'}`,
    `- Files changed: ${s.files} (+${s.additions} −${s.deletions})`,
    `- Checks: ${s.passed}/${s.checks} passed`,
    `- Review findings: ${s.findings} (${s.blocking} blocking)`,
    `- Pull requests: ${d.missionRepos.filter((r) => r.pr).map((r) => r.pr?.url).join(', ') || 'none'}`,
    `- Time: ${formatDuration(s.durationMs)}`,
    `- Cost: ${d.costUsd ? formatUsd(d.costUsd) : 'not reported'}`,
    '',
    '## Requirement',
    '',
    d.revision.body || d.revision.title,
    '',
    '## Plan',
    '',
    d.plan?.summary ?? '—',
  ];
  const share = [
    '# Shipped with Orbit',
    '',
    `A task went from requirement to ${s.prs ? 'pull request' : 'reviewed change'} with an AI engineering team.`,
    '',
    `- ${s.repos} ${s.repos === 1 ? 'repository' : 'repositories'} changed · ${s.files} files (+${s.additions} −${s.deletions})`,
    `- ${s.passed}/${s.checks} checks passed · ${s.blocking} blocking review findings`,
    `- ${formatDuration(s.durationMs)} end to end${d.costUsd ? ` · ${formatUsd(d.costUsd)} in model usage` : ''}`,
    `- Human-approved before anything was pushed`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b0d12"/><stop offset="1" stop-color="#151a24"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="1040" cy="120" r="210" fill="none" stroke="#e8a33d" stroke-opacity="0.18" stroke-width="2"/>
  <circle cx="1040" cy="120" r="140" fill="none" stroke="#e8a33d" stroke-opacity="0.28" stroke-width="2"/>
  <circle cx="1181" cy="175" r="9" fill="#e8a33d"/>
  <text x="80" y="120" font-family="Geist, Inter, system-ui, sans-serif" font-size="30" fill="#e8a33d" letter-spacing="4">ORBIT · MISSION RECEIPT</text>
  <text x="80" y="210" font-family="Geist, Inter, system-ui, sans-serif" font-size="64" font-weight="600" fill="#f4f1ea">${escapeXml(s.prs ? 'Task → pull request' : 'Task → reviewed change')}</text>
  <g font-family="Geist Mono, ui-monospace, monospace" fill="#c9c4b8" font-size="30">
    <text x="80" y="320">${escapeXml(`${s.files} files  +${s.additions} −${s.deletions}`)}</text>
    <text x="80" y="375">${escapeXml(`${s.passed}/${s.checks} checks passed`)}</text>
    <text x="80" y="430">${escapeXml(`${s.blocking} blocking findings`)}</text>
    <text x="80" y="485">${escapeXml(`${formatDuration(s.durationMs)}${d.costUsd ? `  ·  ${formatUsd(d.costUsd)}` : ''}`)}</text>
  </g>
  <text x="80" y="570" font-family="Geist, Inter, system-ui, sans-serif" font-size="24" fill="#8a8578">Human-approved before anything was pushed · orbit-dev</text>
</svg>`;
  return { missionId: d.id, markdown: priv.join('\n'), share: { markdown: share.join('\n'), svg } };
}

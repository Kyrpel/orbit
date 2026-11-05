import { AlertTriangle, ArrowLeft, Check, CircleDashed, ExternalLink, GitBranch, GitPullRequest, Receipt, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  formatDuration,
  formatUsd,
  MISSION_STATE_META,
  truncate,
  type MissionDetailDTO,
  type MissionEventDTO,
  type MissionRepoDTO,
  type ReviewFinding,
  type VerificationDTO,
} from '@orbit/shared';
import { DiffView } from '../components/diff-view';
import { LiveSteps } from '../components/live-steps';
import { stoppedStage, Trajectory } from '../components/trajectory';
import {
  Button,
  Checkbox,
  Code,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Panel,
  PanelHeader,
  StatePill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Textarea,
} from '../components/ui';
import { keys, patch, post, useAction, useDiff, useMission, useMissionEvents, useReceipt } from '../lib/api';
import { clockTime, cn, shortSha, timeAgo } from '../lib/utils';

const ACTIVE = new Set(['DRAFT', 'ANALYZING', 'QUEUED', 'RUNNING', 'VERIFYING']);

function caption(d: MissionDetailDTO, events: MissionEventDTO[] | undefined): string | null {
  const meta = MISSION_STATE_META[d.status];
  if (meta.tone === 'attention' && d.status !== 'FAILED') return 'Waiting for you';
  if (d.status === 'BLOCKED' || d.status === 'FAILED') return truncate(d.blockedReason ?? d.lastError ?? meta.description, 90);
  if (ACTIVE.has(d.status)) {
    const last = [...(events ?? [])].reverse().find((e) => e.kind !== 'state');
    return last ? truncate(last.title, 90) : meta.description;
  }
  if (d.status === 'PR_CREATED') return 'Pull request open';
  return null;
}

// ---------------------------------------------------------------------------
// Decision rail
// ---------------------------------------------------------------------------

function useMissionAction(id: string, action: string, success: string) {
  return useAction((body: unknown) => post(`/api/missions/${id}/${action}`, body), { success, invalidate: [keys.mission(id), ['missions'], keys.overview, keys.events(id)] });
}

/** What this machine still has to allow, from the preflight and (when blocked) the block reason. */
function machineNeeds(d: MissionDetailDTO) {
  const trustedLocal = d.preflight.sandboxUnavailable || d.blockedCode === 'sandbox_unavailable';
  const consent = d.preflight.needsConsent || d.blockedCode === 'needs_consent' || trustedLocal;
  return { consent, trustedLocal, any: consent || trustedLocal };
}

/** Applies the missing machine permissions. Called only from an explicit button press with the explanation on screen. */
async function grantMachineAccess(needs: ReturnType<typeof machineNeeds>) {
  if (needs.consent) await post('/api/consent', { grant: true });
  if (needs.trustedLocal) await patch('/api/settings', { execution: { mode: 'trusted-local' } });
}

function MachineAccessNote({ d }: { d: MissionDetailDTO }) {
  const needs = machineNeeds(d);
  if (!needs.any) return null;
  const commands = d.preflight.commands;
  return (
    <div className="space-y-2 rounded-[10px] border border-signal/45 bg-signal/6 px-4 py-3 text-sm">
      <p className="font-[600]">Orbit needs your permission to work on this PC</p>
      {commands.length ? (
        <p className="text-xs text-dust">
          It will run these commands from your project in its own copy of the code: {commands.map((c, i) => (
            <span key={c}>
              {i ? ', ' : ''}
              <Code>{c}</Code>
            </span>
          ))}
          .
        </p>
      ) : null}
      {needs.trustedLocal ? (
        <p className="text-xs text-dust">Windows cannot sandbox AI agents yet, so the engineer will also run directly on this PC (trusted-local mode).</p>
      ) : null}
      <p className="text-xs text-dust">Everything runs with your user permissions. Nothing is committed or pushed until you approve it. You can withdraw this in Settings.</p>
    </div>
  );
}

function ScopeDecision({ d }: { d: MissionDetailDTO }) {
  const candidates = d.missionRepos;
  const [chosen, setChosen] = useState<string[]>(candidates.filter((r) => r.status === 'selected').map((r) => r.repoId));
  const [notes, setNotes] = useState('');
  const needs = machineNeeds(d);
  const approve = useAction(
    async (body: { repoIds: string[]; notes: string | null }) => {
      await grantMachineAccess(needs);
      return post(`/api/missions/${d.id}/approve-scope`, body);
    },
    { success: 'Scope approved. The engineer is starting.', invalidate: [keys.mission(d.id), ['missions'], keys.overview, keys.settings, keys.doctor] },
  );
  const replan = useMissionAction(d.id, 'replan', 'Replanning');
  const questions = d.plan?.questions ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-dust">
        Confirm which project Orbit may change for this task. Nothing is modified until you approve.
        {!d.triggerVerified ? ' The person who triggered this could not be verified.' : ''}
      </p>
      {questions.length ? (
        <div className="rounded-[10px] border border-seam px-4 py-3 text-sm">
          <p className="font-[600]">The planner is not sure what to change</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-dust">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-dust">Answer in the note below (the engineer reads it), or add details to the task and replan.</p>
        </div>
      ) : null}
      <ul className="divide-y divide-seam rounded-[10px] border border-seam">
        {candidates.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
            <Checkbox id={`scope-${r.id}`} checked={chosen.includes(r.repoId)} onCheckedChange={(v) => setChosen(v ? [...chosen, r.repoId] : chosen.filter((x) => x !== r.repoId))} />
            <label htmlFor={`scope-${r.id}`} className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm text-chalk">{r.repoName}</span>
              <span className="block text-2xs text-dust">{r.status === 'selected' ? 'Proposed by the planner' : 'Authorized but not proposed'}</span>
            </label>
          </li>
        ))}
      </ul>
      <Textarea
        rows={questions.length ? 4 : 2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={questions.length ? 'For example: just add one line to the README saying the project uses Orbit.' : 'Optional note for the engineer'}
      />
      <MachineAccessNote d={d} />
      <div className="flex flex-col gap-2">
        <Button variant="primary" loading={approve.isPending} disabled={chosen.length === 0} onClick={() => approve.mutate({ repoIds: chosen, notes: notes || null })}>
          <ShieldCheck className="size-4" /> {needs.any ? 'Allow and approve scope' : 'Approve scope'}
        </Button>
        <Button loading={replan.isPending} onClick={() => replan.mutate({ refreshSource: true })}>
          Replan with the latest task
        </Button>
      </div>
    </div>
  );
}

function RequestChanges({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const request = useMissionAction(id, 'request-changes', 'Sent back to the engineer');
  return (
    <>
      <Button onClick={() => setOpen(true)}>Request changes</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Request changes"
        description="The engineer continues in the same worktree with your notes and the latest review findings."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!notes.trim()} loading={request.isPending} onClick={() => request.mutate({ notes }, { onSuccess: () => setOpen(false) })}>
              Send to engineer
            </Button>
          </>
        }
      >
        <Textarea autoFocus rows={7} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Use the existing RateLimiter class instead of a new dependency, and cover the 429 path in tests." />
      </Dialog>
    </>
  );
}

function ReviewDecision({ d }: { d: MissionDetailDTO }) {
  const approve = useMissionAction(d.id, 'approve-changes', 'Changes committed locally. Review the pull request next.');
  const latest = d.verifications.filter((v) => v.kind === 'verify').reduce((m, v) => Math.max(m, v.iteration), -1);
  const checks = d.verifications.filter((v) => v.kind === 'verify' && v.iteration === latest);
  const failing = checks.filter((c) => c.status !== 'passed');
  const review = d.reviews[d.reviews.length - 1];
  const blocking = review?.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major') ?? [];
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-sm">
        <li className="flex items-center gap-2">
          {checks.length === 0 ? <CircleDashed className="size-4 text-dust" /> : failing.length ? <X className="size-4 text-fault" /> : <Check className="size-4 text-go" />}
          {checks.length === 0
            ? 'No checks configured'
            : failing.length
              ? `${failing.length} of ${checks.length} ${checks.length === 1 ? 'check' : 'checks'} failing`
              : checks.length === 1
                ? 'The check passed'
                : `All ${checks.length} checks passed`}
        </li>
        <li className="flex items-center gap-2">
          {!review ? <CircleDashed className="size-4 text-dust" /> : blocking.length ? <AlertTriangle className="size-4 text-signal-deep" /> : <Check className="size-4 text-go" />}
          {!review ? 'No automated review' : blocking.length ? `${blocking.length} blocking review finding${blocking.length > 1 ? 's' : ''}` : 'Reviewer found no blocking issues'}
        </li>
      </ul>
      <p className="text-xs text-dust">Approving commits the changes on the mission branch, on this machine only. You approve the pull request separately.</p>
      <div className="flex flex-col gap-2">
        <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate({})}>
          <Check className="size-4" /> Approve changes
        </Button>
        <RequestChanges id={d.id} />
      </div>
    </div>
  );
}

function PublishForm({ d, mr }: { d: MissionDetailDTO; mr: MissionRepoDTO }) {
  const [title, setTitle] = useState(mr.prDraft?.title ?? d.title);
  const [body, setBody] = useState(mr.prDraft?.body ?? '');
  const [draft, setDraft] = useState(false);
  const publish = useMissionAction(d.id, 'publish', 'Publishing: pushing the branch and opening the pull request');
  if (mr.status === 'publishing') {
    return (
      <p className="flex items-center gap-2 text-sm text-telemetry">
        <CircleDashed className="size-4 animate-spin" /> Publishing {mr.repoName}…
      </p>
    );
  }
  if (!mr.remote.hasGitHubRemote) return <p className="text-sm text-dust">{mr.repoName} has no GitHub remote. Finish locally to keep the commit on {mr.branch}.</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-dust">
        Pushes <Code>{mr.branch}</Code> to {mr.remote.owner}/{mr.remote.repo} and opens a pull request into <Code>{mr.prDraft?.base ?? mr.baseBranch}</Code> with your GitHub CLI login. Orbit never merges.
      </p>
      {mr.lastError ? <ErrorNote error={{ message: mr.lastError }} /> : null}
      <Field label="Title" htmlFor={`t-${mr.id}`}>
        <Input id={`t-${mr.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor={`b-${mr.id}`}>
        <Textarea id={`b-${mr.id}`} rows={8} className="mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <label className="flex items-center justify-between gap-3 text-sm">
        Open as draft
        <Switch checked={draft} onCheckedChange={setDraft} label="Open as draft" />
      </label>
      <Button className="w-full" variant="primary" loading={publish.isPending} disabled={!title.trim()} onClick={() => publish.mutate({ missionRepoId: mr.id, title, body, draft })}>
        <GitPullRequest className="size-4" /> Publish pull request
      </Button>
    </div>
  );
}

function PublishDecision({ d }: { d: MissionDetailDTO }) {
  const finish = useMissionAction(d.id, 'finish-local', 'Finished locally');
  const repos = d.missionRepos.filter((r) => ['changes_approved', 'publishing', 'pr_created'].includes(r.status));
  const publishable = repos.some((r) => r.status === 'changes_approved' && r.remote.hasGitHubRemote);
  return (
    <div className="space-y-5">
      {repos.map((mr) =>
        mr.pr ? (
          <a key={mr.id} href={mr.pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-go hover:underline">
            <GitPullRequest className="size-4" /> {mr.repoName} #{mr.pr.number}
          </a>
        ) : (
          <div key={mr.id}>
            {repos.length > 1 ? <p className="mb-2 text-sm font-[600]">{mr.repoName}</p> : null}
            <PublishForm d={d} mr={mr} />
          </div>
        ),
      )}
      <div className="flex flex-col gap-2 border-t border-seam pt-4">
        <Button variant={publishable ? 'secondary' : 'primary'} loading={finish.isPending} onClick={() => finish.mutate({})}>
          Finish without a pull request
        </Button>
        <RequestChanges id={d.id} />
      </div>
    </div>
  );
}

function Decision({ d }: { d: MissionDetailDTO }) {
  const cancel = useMissionAction(d.id, 'cancel', 'Mission cancelled');
  const retry = useMissionAction(d.id, 'retry', 'Retrying');
  const replan = useMissionAction(d.id, 'replan', 'Replanning');
  const complete = useMissionAction(d.id, 'complete', 'Marked complete');
  const allowAndRetry = useAction(
    async () => {
      await grantMachineAccess(machineNeeds(d));
      return post(`/api/missions/${d.id}/retry`, {});
    },
    { success: 'Allowed. Orbit is building now.', invalidate: [keys.mission(d.id), ['missions'], keys.overview, keys.settings, keys.doctor, keys.events(d.id)] },
  );
  const [receipt, setReceipt] = useState(false);
  const meta = MISSION_STATE_META[d.status];

  let title = meta.label;
  let body: React.ReactNode = <p className="text-sm text-dust">{meta.description}</p>;
  if (d.status === 'AWAITING_SCOPE_APPROVAL') {
    title = 'Confirm the scope';
    body = <ScopeDecision d={d} />;
  } else if (d.status === 'AWAITING_REVIEW') {
    title = 'Review the changes';
    body = <ReviewDecision d={d} />;
  } else if (d.status === 'AWAITING_PR_APPROVAL') {
    title = 'Approve the pull request';
    body = <PublishDecision d={d} />;
  } else if (d.status === 'BLOCKED' || d.status === 'FAILED') {
    title = d.status === 'BLOCKED' ? 'Orbit needs you' : 'The mission failed';
    const machineFix =
      d.status === 'BLOCKED' && (d.blockedCode === 'needs_consent' || d.blockedCode === 'sandbox_unavailable' || (!d.blockedCode && machineNeeds(d).any));
    body = (
      <div className="space-y-4">
        <p className="text-sm text-chalk">{d.blockedReason ?? d.lastError ?? 'No reason recorded.'}</p>
        {machineFix ? <MachineAccessNote d={d} /> : null}
        {d.blockedCode === 'runtime_unavailable' ? (
          <p className="text-xs text-dust">
            Pick a runtime that is ready in <Link to="/settings" className="underline">Settings</Link>, then retry.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          {machineFix ? (
            <Button variant="primary" loading={allowAndRetry.isPending} onClick={() => allowAndRetry.mutate(undefined)}>
              <RotateCcw className="size-4" /> Allow and retry
            </Button>
          ) : null}
          <Button variant={machineFix ? 'secondary' : 'primary'} loading={retry.isPending} onClick={() => retry.mutate({})}>
            <RotateCcw className="size-4" /> Retry
          </Button>
          <Button loading={replan.isPending} onClick={() => replan.mutate({ refreshSource: true })}>
            Replan from the task
          </Button>
        </div>
      </div>
    );
  } else if (d.status === 'PR_CREATED') {
    title = 'Pull request open';
    body = (
      <div className="space-y-3">
        {d.missionRepos
          .filter((r) => r.pr)
          .map((r) => (
            <a key={r.id} href={r.pr?.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-go hover:underline">
              <GitPullRequest className="size-4" /> {r.repoName} #{r.pr?.number} <ExternalLink className="size-3.5" />
            </a>
          ))}
        <p className="text-xs text-dust">Merge it on GitHub when you are happy. Orbit never merges for you.</p>
        <Button className="w-full" loading={complete.isPending} onClick={() => complete.mutate({})}>
          Mark mission complete
        </Button>
      </div>
    );
  } else if (ACTIVE.has(d.status)) {
    title = 'Orbit is working';
    body = <p className="text-sm text-dust">{meta.description} You can leave this page; progress is saved and continues after restarts.</p>;
  }

  const cancellable = !['COMPLETED', 'CANCELLED', 'PR_CREATED'].includes(d.status);
  return (
    <Panel className={cn(meta.tone === 'attention' && 'border-signal/45')}>
      <PanelHeader title={title} />
      <div className="space-y-4 px-5 py-4">
        {body}
        {cancellable ? (
          <Button variant="ghost" size="sm" className="w-full text-dust" loading={cancel.isPending} onClick={() => cancel.mutate({ reason: null })}>
            Cancel mission
          </Button>
        ) : null}
        {d.status === 'PR_CREATED' || d.status === 'COMPLETED' ? (
          <Button variant="ghost" size="sm" className="w-full" onClick={() => setReceipt(true)}>
            <Receipt className="size-4" /> Mission receipt
          </Button>
        ) : null}
      </div>
      <ReceiptDialog id={d.id} open={receipt} onOpenChange={setReceipt} />
    </Panel>
  );
}

function ReceiptDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const receipt = useReceipt(id, open);
  const [mode, setMode] = useState<'share' | 'private'>('share');
  const r = receipt.data;
  const svgUrl = r ? `data:image/svg+xml;utf8,${encodeURIComponent(r.share.svg)}` : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Mission receipt" description="The share version leaves out repository names, task text, people and code." wide>
      {!r ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'share' ? 'primary' : 'secondary'} onClick={() => setMode('share')}>
              Share version
            </Button>
            <Button size="sm" variant={mode === 'private' ? 'primary' : 'secondary'} onClick={() => setMode('private')}>
              Private version
            </Button>
          </div>
          {mode === 'share' ? <img src={svgUrl} alt="Mission receipt card" className="w-full rounded-[10px] border border-seam" /> : null}
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-[10px] border border-seam bg-night p-4 text-xs">{mode === 'share' ? r.share.markdown : r.markdown}</pre>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(mode === 'share' ? r.share.markdown : r.markdown)}>
              Copy Markdown
            </Button>
            {mode === 'share' ? (
              <a href={svgUrl} download={`orbit-${id}.svg`}>
                <Button size="sm">Download card</Button>
              </a>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function Overview({ d }: { d: MissionDetailDTO }) {
  const plan = d.plan;
  return (
    <div className="divide-y divide-seam">
      <section className="px-6 py-5">
        <h3 className="text-sm text-dust">Requirement{d.revisionCount > 1 ? `, revision ${d.revision.revision} of ${d.revisionCount}` : ''}</h3>
        <p className="mt-2 text-base font-[600]">{d.revision.title}</p>
        {d.revision.body ? <p className="mt-2 max-w-[72ch] whitespace-pre-wrap text-sm text-chalk/90">{d.revision.body}</p> : <p className="mt-2 text-sm text-dust">No description.</p>}
        {d.revision.extraInstructions ? (
          <p className="mt-3 max-w-[72ch] whitespace-pre-wrap rounded-[8px] bg-night px-3 py-2 text-sm text-chalk/90">{d.revision.extraInstructions}</p>
        ) : null}
        {d.revision.comments.length ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-dust">{d.revision.comments.length} task comments included</summary>
            <ul className="mt-2 space-y-2">
              {d.revision.comments.map((c) => (
                <li key={c.id} className="max-w-[72ch] text-chalk/85">
                  <span className="text-dust">{c.author ?? 'someone'}:</span> {c.text}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      <section className="px-6 py-5">
        <h3 className="text-sm text-dust">Plan</h3>
        {!plan ? (
          <p className="mt-2 text-sm text-dust">The planner has not produced a plan yet.</p>
        ) : (
          <div className="mt-2 space-y-4">
            <p className="max-w-[72ch] text-sm text-chalk">{plan.summary}</p>
            {plan.steps.length ? (
              <ol className="max-w-[72ch] list-decimal space-y-1 pl-5 text-sm text-chalk/90 marker:text-dust">
                {plan.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : null}
            {plan.acceptanceCriteria.length ? (
              <div>
                <p className="text-xs font-[600]">Acceptance criteria</p>
                <ul className="mt-1.5 max-w-[72ch] space-y-1 text-sm text-chalk/90">
                  {plan.acceptanceCriteria.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-dust" aria-hidden />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.questions.length ? (
              <div className="rounded-[8px] border border-signal/35 bg-signal/6 px-4 py-3">
                <p className="text-xs font-[600] text-signal-deep">Open questions from the planner</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {plan.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.droppedRepositories.length ? (
              <p className="text-xs text-fault">Ignored {plan.droppedRepositories.map((r) => `"${r.name}"`).join(', ')}: not authorized for this mission.</p>
            ) : null}
          </div>
        )}
      </section>
      <section className="px-6 py-5">
        <h3 className="text-sm text-dust">Why these repositories</h3>
        <ul className="mt-3 space-y-4">
          {d.missionRepos.map((r) => (
            <li key={r.id} className={cn(r.status === 'excluded' && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-[600]">{r.repoName}</span>
                <Tag tone={r.status === 'excluded' ? 'neutral' : 'active'}>{r.status === 'excluded' ? 'not in scope' : r.selection?.source === 'user' ? 'added by you' : r.selection?.source === 'mapping' ? 'only mapped repo' : 'chosen by planner'}</Tag>
              </div>
              {r.selection ? (
                <div className="mt-1.5 max-w-[72ch] space-y-1.5 text-sm text-chalk/90">
                  {r.selection.reason ? <p>{r.selection.reason}</p> : null}
                  {r.selection.evidence.length ? (
                    <ul className="space-y-0.5 text-xs text-dust">
                      {r.selection.evidence.map((e, i) => (
                        <li key={i}>Evidence: {e}</li>
                      ))}
                    </ul>
                  ) : null}
                  {r.selection.likelyFiles.length ? <p className="mono text-2xs text-dust">{r.selection.likelyFiles.join('  ')}</p> : null}
                  {r.selection.risks.length ? <p className="text-xs text-signal-deep">Risks: {r.selection.risks.join('; ')}</p> : null}
                  {r.selection.uncertainty ? <p className="text-xs text-dust">Unknowns: {r.selection.uncertainty}</p> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Changes({ d }: { d: MissionDetailDTO }) {
  const withDiff = d.missionRepos.filter((r) => r.baseSha);
  const [active, setActive] = useState<string | null>(withDiff[0]?.id ?? null);
  const current = withDiff.find((r) => r.id === active) ?? withDiff[0] ?? null;
  const diff = useDiff(d.id, current?.id ?? null, `${current?.status}-${current?.commitSha}-${d.updatedAt}`);
  if (!current) return <Empty title="No changes yet.">The diff appears here as soon as the engineer has worked in the worktree.</Empty>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-seam px-4 py-3 text-xs">
        {withDiff.length > 1
          ? withDiff.map((r) => (
              <Button key={r.id} size="sm" variant={r.id === current.id ? 'primary' : 'secondary'} onClick={() => setActive(r.id)}>
                {r.repoName}
              </Button>
            ))
          : null}
        <span className="flex items-center gap-1.5 text-dust">
          <GitBranch className="size-3.5" aria-hidden />
          <span className="mono">{current.branch}</span> from <span className="mono">{current.baseBranch}</span> at <span className="mono">{shortSha(current.baseSha)}</span>
        </span>
        {current.commitSha ? <span className="text-dust">committed as <span className="mono">{shortSha(current.commitSha)}</span></span> : <span className="text-dust">not committed yet</span>}
      </div>
      {diff.isPending ? <Loading label="Reading the diff" /> : diff.error ? <div className="p-4"><ErrorNote error={diff.error} /></div> : <DiffView diff={diff.data.diff} truncated={diff.data.truncated} />}
    </div>
  );
}

function CheckRow({ v }: { v: VerificationDTO }) {
  const [open, setOpen] = useState(v.status !== 'passed' && v.status !== 'running');
  const icon =
    v.status === 'passed' ? <Check className="size-4 text-go" /> : v.status === 'running' ? <CircleDashed className="size-4 animate-spin text-telemetry" /> : <X className="size-4 text-fault" />;
  return (
    <li>
      <button className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-hull-2/60" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {icon}
        <span className="w-28 shrink-0 text-sm">{v.kind === 'setup' ? `Setup: ${v.label}` : v.label}</span>
        <span className="mono min-w-0 flex-1 truncate text-xs text-dust">{v.command}</span>
        <span className="text-2xs text-dust tabular">{v.exitCode != null ? `exit ${v.exitCode}` : v.status}</span>
        <span className="w-14 text-right text-2xs text-dust tabular">{formatDuration(v.durationMs)}</span>
      </button>
      {open && v.outputTail ? <pre className="mono mx-5 mb-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-[8px] border border-seam bg-night p-3 text-[12px] leading-relaxed text-chalk/85">{v.outputTail}</pre> : null}
    </li>
  );
}

function Checks({ d }: { d: MissionDetailDTO }) {
  const byIteration = useMemo(() => {
    const map = new Map<number, VerificationDTO[]>();
    for (const v of d.verifications) map.set(v.iteration, [...(map.get(v.iteration) ?? []), v]);
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }, [d.verifications]);
  if (!byIteration.length) return <Empty title="No checks have run yet.">Orbit runs your repository's verification commands itself after each implementation pass. Configure them in Projects.</Empty>;
  return (
    <div className="divide-y divide-seam">
      {byIteration.map(([iteration, list], i) => (
        <section key={iteration} className="py-2">
          <p className="px-5 pb-1 pt-2 text-xs text-dust">{i === 0 ? 'Latest pass' : `Earlier pass ${iteration}`}</p>
          <ul>{list.map((v) => <CheckRow key={v.id} v={v} />)}</ul>
        </section>
      ))}
    </div>
  );
}

const SEVERITY_TONE: Record<ReviewFinding['severity'], 'danger' | 'attention' | 'neutral'> = { blocker: 'danger', major: 'attention', minor: 'neutral', nit: 'neutral' };

const SECURITY_SEVERITY: Record<string, string> = { blocker: 'critical', major: 'high', minor: 'medium', nit: 'low' };

function ReviewTab({ d }: { d: MissionDetailDTO }) {
  const quality = [...d.reviews].reverse().find((r) => r.kind !== 'security');
  const security = [...d.reviews].reverse().find((r) => r.kind === 'security');
  if (!quality && !security) return <Empty title="No review yet.">The reviewer reads the real diff together with check results Orbit captured itself. The security reviewer then checks it for security problems.</Empty>;
  return (
    <div className="divide-y divide-seam">
      {quality ? <ReviewBlock d={d} review={quality} title="Reviewer" /> : null}
      {security ? <ReviewBlock d={d} review={security} title="Security reviewer" /> : null}
    </div>
  );
}

function ReviewBlock({ d, review, title }: { d: MissionDetailDTO; review: MissionDetailDTO['reviews'][number]; title: string }) {
  const scripted = d.agentRuns.find((r) => r.id === review.agentRunId)?.runtime === 'scripted';
  const isSecurity = review.kind === 'security';
  return (
    <div className="space-y-5 px-6 py-5">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-[650]">{title}</span>
          <Tag tone={review.verdict === 'approve' ? 'success' : 'attention'}>{review.verdict === 'approve' ? (isSecurity ? 'No serious issues' : 'Approve') : isSecurity ? 'Security issues' : 'Changes requested'}</Tag>
          {scripted ? <Tag>Scripted runtime, not an AI review</Tag> : null}
          <span className="text-2xs text-dust">{timeAgo(review.createdAt)}</span>
        </div>
        <p className="mt-2 max-w-[72ch] text-sm">{review.summary}</p>
      </div>
      {review.criteria.length ? (
        <ul className="divide-y divide-seam rounded-[10px] border border-seam">
          {review.criteria.map((c, i) => (
            <li key={i} className="flex gap-3 px-4 py-2.5 text-sm">
              {c.status === 'met' ? <Check className="mt-0.5 size-4 shrink-0 text-go" /> : c.status === 'not_met' ? <X className="mt-0.5 size-4 shrink-0 text-fault" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-dust" />}
              <div>
                <p>{c.criterion}</p>
                {c.notes ? <p className="text-xs text-dust">{c.notes}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {review.findings.length ? (
        <ul className="space-y-3">
          {review.findings.map((f, i) => (
            <li key={i} className="rounded-[10px] border border-seam px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={SEVERITY_TONE[f.severity]}>{isSecurity ? SECURITY_SEVERITY[f.severity] : f.severity}</Tag>
                <span className="text-sm font-[600]">{f.title}</span>
                {f.file ? <span className="mono text-2xs text-dust">{f.file}{f.line ? `:${f.line}` : ''}</span> : null}
              </div>
              {f.detail ? <p className="mt-1.5 max-w-[72ch] text-sm text-chalk/90">{f.detail}</p> : null}
              {f.suggestion ? <p className="mt-1 max-w-[72ch] text-xs text-dust">Suggestion: {f.suggestion}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-dust">No findings.</p>
      )}
    </div>
  );
}

const ACTOR_COLOR: Record<string, string> = { planner: 'text-telemetry', engineer: 'text-telemetry', reviewer: 'text-telemetry', security: 'text-telemetry', user: 'text-signal-deep', asana: 'text-chalk', github: 'text-go', git: 'text-dust', system: 'text-dust' };

function Timeline({ events }: { events: MissionEventDTO[] }) {
  const [showTools, setShowTools] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const visible = events.filter((e) => showTools || e.kind !== 'tool');
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [visible.length]);
  return (
    <div>
      <div className="flex items-center justify-between border-b border-seam px-5 py-2.5 text-xs text-dust">
        <span>{events.length} events, saved permanently</span>
        <label className="flex items-center gap-2">
          Show tool calls <Switch checked={showTools} onCheckedChange={setShowTools} label="Show tool calls" />
        </label>
      </div>
      <div ref={box} className="max-h-[640px] overflow-y-auto">
        <ol className="py-2">
          {visible.map((e) => (
            <li key={e.id} className="grid grid-cols-[72px_80px_minmax(0,1fr)] gap-3 px-5 py-1.5 text-sm">
              <span className="text-2xs leading-6 text-dust-2 tabular">{clockTime(e.ts)}</span>
              <span className={cn('text-2xs leading-6', ACTOR_COLOR[e.actor] ?? 'text-dust')}>{e.actor}</span>
              <div className="min-w-0">
                <p className={cn('leading-6', e.kind === 'error' ? 'text-fault' : e.kind === 'state' ? 'font-[600] text-chalk' : e.kind === 'tool' ? 'mono text-xs text-dust' : 'text-chalk/90')}>{e.title}</p>
                {e.detail && e.detail !== e.title ? (
                  <details className="text-xs text-dust">
                    <summary className="cursor-pointer select-none">details</summary>
                    <pre className="mono mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] bg-night p-2 text-[12px]">{e.detail}</pre>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Facts({ d }: { d: MissionDetailDTO }) {
  const rows: [string, React.ReactNode][] = [
    ['Source', d.source.url ? <a href={d.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{d.source.provider === 'asana' ? 'Asana task' : 'Task'} <ExternalLink className="size-3" /></a> : 'Typed in Orbit'],
    ['Started by', `${d.triggeredBy?.name ?? 'unknown'}${d.triggerVerified ? '' : ' (unverified)'} via ${d.entryPoint}`],
    ['Runtime', d.runtime === 'scripted' ? 'Scripted demo, no AI' : (d.runtime ?? 'not started')],
    d.runtime === 'claude-code-cli'
      ? ['Plan usage', <span title="Runs through your Claude Code plan are not billed per token. Claude Code estimates what the same work would cost at API prices.">≈ {formatUsd(d.costUsd)} at API prices</span>]
      : ['Model cost', formatUsd(d.costUsd)],
    ['Passes', String(d.iteration)],
    ['Created', timeAgo(d.createdAt)],
  ];
  return (
    <Panel>
      <dl className="divide-y divide-seam text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
            <dt className="text-xs text-dust">{k}</dt>
            <dd className="min-w-0 truncate text-right">{v}</dd>
          </div>
        ))}
        {d.missionRepos
          .filter((r) => r.worktreePath)
          .map((r) => (
            <div key={r.id} className="px-5 py-2.5">
              <dt className="text-xs text-dust">Worktree for {r.repoName}</dt>
              <dd className="mono mt-0.5 break-all text-2xs text-chalk/80">{r.worktreePath}</dd>
            </div>
          ))}
      </dl>
    </Panel>
  );
}

export function MissionPage() {
  const { id = '' } = useParams();
  const mission = useMission(id);
  const events = useMissionEvents(id);
  // Until the user picks a tab: Live while agents work, otherwise the plan.
  const [picked, setPicked] = useState<string | null>(null);
  const replan = useMissionAction(id, 'replan', 'Replanning with the latest task');
  const d = mission.data;

  useEffect(() => {
    if (d && (d.status === 'AWAITING_REVIEW' || d.status === 'AWAITING_PR_APPROVAL') && (picked === null || picked === 'overview' || picked === 'live')) setPicked('changes');
    // only when the state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.status]);

  if (mission.isPending) return <Loading />;
  if (mission.error || !d) return <ErrorNote error={mission.error} />;

  const latest = d.verifications.filter((v) => v.kind === 'verify').reduce((m, v) => Math.max(m, v.iteration), -1);
  const checks = d.verifications.filter((v) => v.kind === 'verify' && v.iteration === latest);
  const files = d.missionRepos.reduce((n, r) => n + (r.diffStats?.files ?? 0), 0);
  const working = ACTIVE.has(d.status);
  const tab = picked ?? (working ? 'live' : 'overview');

  return (
    <>
      <Link to="/missions" className="mb-5 inline-flex items-center gap-1.5 text-xs text-dust hover:text-chalk">
        <ArrowLeft className="size-3.5" /> Missions
      </Link>
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="max-w-[48ch] text-2xl">{d.title}</h1>
          <StatePill status={d.status} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dust">
          <span className="mono">{d.id}</span>
          {d.missionRepos
            .filter((r) => r.status !== 'excluded')
            .map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" aria-hidden /> {r.repoName}
                {r.branch ? <span className="mono text-dust-2">{r.branch}</span> : null}
              </span>
            ))}
          <span>updated {timeAgo(d.updatedAt)}</span>
        </div>
      </header>

      {d.requirementsChanged ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-signal/40 bg-signal/6 px-4 py-3 text-sm">
          <span>The task changed after this mission started. Orbit is still working from the snapshot it took at the start.</span>
          {d.allowedActions.includes('replan') ? (
            <Button size="sm" loading={replan.isPending} onClick={() => replan.mutate({ refreshSource: true })}>
              Replan with the latest version
            </Button>
          ) : null}
        </div>
      ) : null}

      <Panel className="mb-6 px-6 pb-4 pt-5">
        <Trajectory status={d.status} stoppedAt={stoppedStage(d)} caption={caption(d, events.data)} />
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel className="min-w-0 overflow-hidden">
          <Tabs value={tab} onValueChange={setPicked}>
            <TabsList className="overflow-x-auto">
              <TabsTrigger value="live">
                {working ? <span className="size-2 rounded-full bg-current text-telemetry animate-beacon" aria-hidden /> : null}
                Live
                {working ? <span className="sr-only"> (agents working)</span> : null}
              </TabsTrigger>
              <TabsTrigger value="overview">Plan</TabsTrigger>
              <TabsTrigger value="changes">
                Changes {files ? <span className="text-2xs text-dust tabular">{files}</span> : null}
              </TabsTrigger>
              <TabsTrigger value="checks">
                Checks {checks.length ? <span className={cn('text-2xs tabular', checks.every((c) => c.status === 'passed') ? 'text-go' : 'text-fault')}>{checks.filter((c) => c.status === 'passed').length}/{checks.length}</span> : null}
              </TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>
            <TabsContent value="live">{events.data ? <LiveSteps events={events.data} status={d.status} active={working} /> : <Loading />}</TabsContent>
            <TabsContent value="overview">
              <Overview d={d} />
            </TabsContent>
            <TabsContent value="changes">
              <Changes d={d} />
            </TabsContent>
            <TabsContent value="checks">
              <Checks d={d} />
            </TabsContent>
            <TabsContent value="review">
              <ReviewTab d={d} />
            </TabsContent>
            <TabsContent value="timeline">{events.data ? <Timeline events={events.data} /> : <Loading />}</TabsContent>
          </Tabs>
        </Panel>
        <aside className="space-y-6">
          <Decision d={d} />
          <Facts d={d} />
        </aside>
      </div>
    </>
  );
}

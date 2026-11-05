import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emptyResult, type AgentRunContext, type AgentRunRequest, type AgentRunResult, type AgentRuntime, type RuntimeAvailability } from './runtime';

export type ScriptHandler = (req: AgentRunRequest, ctx: AgentRunContext) => Promise<Partial<AgentRunResult>>;

export interface ScriptedRuntimeOptions {
  planner?: ScriptHandler;
  engineer?: ScriptHandler;
  reviewer?: ScriptHandler;
  security?: ScriptHandler;
  prompter?: ScriptHandler;
  assistant?: ScriptHandler;
}

function between(text: string, tag: string): string {
  const m = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text);
  return (m?.[1] ?? '').trim();
}

/** Default demo planner: picks repositories with keyword matches, else the first one. */
export const demoPlanner: ScriptHandler = async (req) => {
  const keys = [...req.prompt.matchAll(/^### key: (.+)$/gm)].map((m) => (m[1] ?? '').trim());
  const sections = req.prompt.split(/^### key: /m).slice(1);
  const matched = sections.filter((s) => /keyword matches:/.test(s)).map((s) => s.split('\n')[0]?.trim() ?? '');
  const chosen = (matched.length ? matched : keys.slice(0, 1)).filter(Boolean);
  return {
    structured: {
      summary: 'Scripted demo plan (no AI): record the task in ORBIT_DEMO.md so the full review and PR flow can be exercised.',
      steps: ['Create or update ORBIT_DEMO.md with the task title and description.'],
      acceptanceCriteria: ['ORBIT_DEMO.md contains the task title.'],
      repositories: chosen.map((key) => ({
        repoKey: key,
        reason: matched.length ? 'Task keywords match this repository.' : 'First authorized repository.',
        evidence: [],
        likelyFiles: ['ORBIT_DEMO.md'],
        changeSummary: 'Add ORBIT_DEMO.md',
        risks: [],
        uncertainty: 'Scripted runtime: no code was analyzed.',
      })),
      questions: [],
      needsHumanDecision: false,
    },
    text: 'Scripted plan ready.',
  };
};

/** Default demo engineer: writes ORBIT_DEMO.md in the worktree. Real file change, no AI. */
export const demoEngineer: ScriptHandler = async (req, ctx) => {
  const title = between(req.prompt, 'untrusted_task_title') || 'Orbit task';
  const body = between(req.prompt, 'untrusted_task_description');
  const file = path.join(req.cwd, 'ORBIT_DEMO.md');
  mkdirSync(path.dirname(file), { recursive: true });
  ctx.onEvent({ type: 'tool', tool: 'Write', summary: 'Write ORBIT_DEMO.md' });
  writeFileSync(file, `# ${title}\n\n${body ? `${body}\n\n` : ''}_Written by the Orbit scripted demo runtime (no AI)._\n`, 'utf8');
  return {
    structured: {
      summary: 'Scripted demo change: wrote ORBIT_DEMO.md.',
      changes: [{ file: 'ORBIT_DEMO.md', description: 'Documents the task.' }],
      testsAddedOrUpdated: [],
      blocked: false,
      blockerReason: '',
      followUps: [],
    },
    text: 'Wrote ORBIT_DEMO.md',
  };
};

export const demoAssistant: ScriptHandler = async () => ({
  text: 'Scripted answer (no AI): the scripted demo runtime does not read your code. Connect Claude Code or Codex for real answers.',
});

export const demoSecurity: ScriptHandler = async () => ({
  structured: { verdict: 'pass', summary: 'Scripted security review (no AI): the diff was not analyzed.', findings: [] },
  text: 'Scripted security review complete.',
});

export const demoPrompter: ScriptHandler = async (req) => {
  const title = between(req.prompt, 'untrusted_task_title') || 'Task';
  const description = between(req.prompt, 'untrusted_task_description');
  return {
    structured: {
      title,
      description: `${description}\n\n(Scripted demo: not rewritten by an AI.)`.trim(),
      acceptanceCriteria: ['The change does what the task describes.'],
      openQuestions: [],
      whatChanged: 'Scripted demo runtime: no AI rewrite.',
    },
    text: 'Scripted task rewrite.',
  };
};

export const demoReviewer: ScriptHandler = async () => ({
  structured: {
    verdict: 'approve',
    summary: 'Scripted review (no AI): the diff was not analyzed. Review it yourself before approving.',
    criteria: [],
    findings: [],
  },
  text: 'Scripted review complete.',
});

/**
 * Deterministic runtime without AI. Used by automated tests and the opt-in demo
 * mode. Everything it produces is labeled as scripted in the dashboard.
 */
export class ScriptedRuntime implements AgentRuntime {
  readonly id = 'scripted' as const;
  readonly displayName = 'Scripted demo (no AI)';
  readonly kind = 'scripted' as const;
  constructor(private readonly handlers: ScriptedRuntimeOptions = {}) {}

  async checkAvailability(): Promise<RuntimeAvailability> {
    return { available: true, reason: null, sandbox: 'unavailable', details: { note: 'Makes scripted file changes without AI.' } };
  }

  async run(req: AgentRunRequest, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now();
    const handler =
      req.role === 'planner'
        ? (this.handlers.planner ?? demoPlanner)
        : req.role === 'engineer'
          ? (this.handlers.engineer ?? demoEngineer)
          : req.role === 'assistant'
            ? (this.handlers.assistant ?? demoAssistant)
            : req.role === 'security'
              ? (this.handlers.security ?? demoSecurity)
              : req.role === 'prompter'
                ? (this.handlers.prompter ?? demoPrompter)
                : (this.handlers.reviewer ?? demoReviewer);
    ctx.onEvent({ type: 'status', message: `Scripted ${req.role} started` });
    if (ctx.signal.aborted) return emptyResult({ status: 'cancelled', durationMs: 0 });
    try {
      const partial = await handler(req, ctx);
      return emptyResult({ status: 'succeeded', durationMs: Date.now() - started, costUsd: 0, numTurns: 1, model: 'scripted', ...partial });
    } catch (err) {
      return emptyResult({ status: 'failed', durationMs: Date.now() - started, error: (err as Error).message });
    }
  }
}

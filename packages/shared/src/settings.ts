import { z } from 'zod';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Working sessions write real code, so they get the strongest model by default. */
export const DEFAULT_ASSISTANT_MODEL = DEFAULT_MODEL;

export const KNOWN_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
] as const;

const ExecutionSettings = z.object({
  /**
   * Which agent runtime runs missions. `auto` uses your Claude Code plan when Claude Code is
   * installed and signed in, otherwise an API key or cloud provider from the environment.
   */
  runtime: z.enum(['auto', 'claude-agent-sdk', 'claude-code-cli', 'scripted']).default('auto'),
  /**
   * Where mission worktrees are created. Null keeps them under ORBIT_HOME. On Windows, Codex's
   * sandbox cannot run Node inside your user folder, so Codex work needs a folder outside it.
   */
  worktreeRoot: z.string().trim().min(1).nullable().default(null),
  /**
   * `sandbox`: agent tool calls must run inside Claude Code's OS sandbox, or the run fails.
   * `trusted-local`: agents run directly on this machine with your user permissions.
   */
  mode: z.enum(['sandbox', 'trusted-local']).default('sandbox'),
  /**
   * Consent to run commands on this machine: setup/verification commands (always
   * executed by Orbit on the host, against agent-written code) and trusted-local agents.
   */
  localExecutionConsentAt: z.string().nullable().default(null),
  maxConcurrentMissions: z.number().int().min(1).max(8).default(1),
  agentTimeoutMinutes: z.number().int().min(1).max(240).default(30),
  commandTimeoutMinutes: z.number().int().min(1).max(120).default(15),
  maxFixIterations: z.number().int().min(0).max(5).default(2),
  maxBudgetUsdPerRun: z.number().min(0).max(500).nullable().default(5),
  maxTurns: z.number().int().min(5).max(500).default(80),
  allowAgentNetwork: z.boolean().default(false),
  /** How new working sessions handle commands: ask first, or auto (Claude Code's auto mode). */
  sessionCommands: z.enum(['ask', 'auto']).default('ask'),
  /** After each answer, suggest your likely next message (a small, cheap model call), like Claude Code. */
  suggestNext: z.boolean().default(true),
  /**
   * Session agents may read your Claude Code and Codex sessions from outside Orbit (as
   * condensed transcripts Orbit keeps in its data folder), and you can point at one with @past.
   */
  pastSessions: z.boolean().default(true),
});

const ModelSettings = z.object({
  planner: z.string().min(1).default(DEFAULT_MODEL),
  engineer: z.string().min(1).default(DEFAULT_MODEL),
  reviewer: z.string().min(1).default(DEFAULT_MODEL),
  security: z.string().min(1).default(DEFAULT_MODEL),
  prompter: z.string().min(1).default('claude-sonnet-5-5'),
  assistant: z.string().min(1).default(DEFAULT_ASSISTANT_MODEL),
});

/** Codex model per seat. Null uses Codex's own default model. */
const CodexModelSettings = z.object({
  planner: z.string().min(1).nullable().default(null),
  engineer: z.string().min(1).nullable().default(null),
  reviewer: z.string().min(1).nullable().default(null),
  security: z.string().min(1).nullable().default(null),
  prompter: z.string().min(1).nullable().default(null),
  assistant: z.string().min(1).nullable().default(null),
});

export const AI_PROVIDERS = ['auto', 'claude', 'codex'] as const;
export type AiProviderChoice = (typeof AI_PROVIDERS)[number];

/**
 * Which AI each seat of the team uses. `auto` picks per seat: Claude plans, builds and
 * answers; the reviewer uses the other AI when it can, so the change gets a second opinion
 * from a different model.
 */
const TeamSettings = z.object({
  planner: z.enum(AI_PROVIDERS).default('auto'),
  engineer: z.enum(AI_PROVIDERS).default('auto'),
  reviewer: z.enum(AI_PROVIDERS).default('auto'),
  security: z.enum(AI_PROVIDERS).default('auto'),
  prompter: z.enum(AI_PROVIDERS).default('auto'),
  assistant: z.enum(AI_PROVIDERS).default('auto'),
  /** Switch to the other AI when one is not ready or hits its usage limit. */
  fallback: z.boolean().default(true),
  /** Run the security reviewer on every mission's changes. */
  securityReview: z.boolean().default(true),
});

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_INFO: Readonly<Record<EffortLevel, { label: string; description: string }>> = {
  low: { label: 'Low', description: 'Fastest and cheapest. Simple, well-specified work.' },
  medium: { label: 'Medium', description: 'Balanced. Opus 5.5 uses this when nothing is set.' },
  high: { label: 'High', description: 'Careful reasoning for planning and review.' },
  xhigh: { label: 'Extra high', description: 'Recommended for coding: deeper reasoning on real changes.' },
  max: { label: 'Max', description: 'Most thorough. Slower and uses the most tokens; for hard tasks.' },
};

/**
 * Reasoning effort per role. Coding benefits most from higher effort, so the engineer
 * defaults to `xhigh`; planning and review default to `high`.
 */
const EffortSettings = z.object({
  planner: z.enum(EFFORT_LEVELS).default('high'),
  engineer: z.enum(EFFORT_LEVELS).default('xhigh'),
  reviewer: z.enum(EFFORT_LEVELS).default('high'),
  security: z.enum(EFFORT_LEVELS).default('high'),
  prompter: z.enum(EFFORT_LEVELS).default('medium'),
  assistant: z.enum(EFFORT_LEVELS).default('high'),
});

const ApprovalSettings = z.object({
  /** `always`: every mission waits for scope approval. `when-ambiguous`: only multi-repo, unverified or unclear missions do. */
  scope: z.enum(['always', 'when-ambiguous']).default('when-ambiguous'),
});

const AsanaSettings = z.object({
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(30),
  commentVerbosity: z.enum(['minimal', 'normal']).default('normal'),
  reconcileEveryMinutes: z.number().int().min(0).max(1440).default(15),
  reconcileTaskLimit: z.number().int().min(1).max(200).default(25),
  requestsPerMinute: z.number().int().min(10).max(1500).default(150),
});

const GitHubSettings = z.object({
  draftPullRequests: z.boolean().default(false),
  /** Public repos never get task links or requirement text in PR bodies unless this is on. */
  includeSourceInPublicRepos: z.boolean().default(false),
});

/** An OpenRouter model id, like `deepseek/deepseek-v4.1-flash-1017` (`~` and `:` variants included). */
export const OPENROUTER_SLUG = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** A session model `openrouter:<slug>` runs in Claude Code, through OpenRouter. */
export const OPENROUTER_PREFIX = 'openrouter:';

export const isOpenRouterModel = (model: string | null | undefined): model is string => !!model && model.startsWith(OPENROUTER_PREFIX);

export const openRouterSlug = (model: string) => model.slice(OPENROUTER_PREFIX.length);

/** A session model `hf:<endpoint name>` runs in Claude Code, on your Hugging Face endpoint. */
export const HF_PREFIX = 'hf:';

export const isHfModel = (model: string | null | undefined): model is string => !!model && model.startsWith(HF_PREFIX);

/** Which AI a model belongs to: Claude's own, OpenRouter's (`openrouter:…`), a Hugging Face endpoint (`hf:…`), or Codex's (anything else). */
export function modelProvider(model: string): 'claude' | 'codex' | 'openrouter' | 'huggingface' {
  return model.startsWith(OPENROUTER_PREFIX) ? 'openrouter' : model.startsWith(HF_PREFIX) ? 'huggingface' : model.startsWith('claude-') ? 'claude' : 'codex';
}

/**
 * The model repository in a Hugging Face link: `https://huggingface.co/<owner>/<repo>`, the
 * endpoint page `https://endpoints.huggingface.co/new/<owner>/<repo>`, or just `<owner>/<repo>`.
 */
export function parseHfRepository(input: string): string | null {
  let s = input.trim();
  const url = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co|endpoints\.huggingface\.co\/new)\/([^?#]+)/i.exec(s);
  if (url) s = decodeURIComponent(url[1]!).replace(/\/+$/, '');
  const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?:\/(?:tree|blob|resolve)\/.*)?$/.exec(s);
  if (!m) return null;
  if (['models', 'datasets', 'spaces', 'docs', 'settings', 'organizations'].includes(m[1]!.toLowerCase())) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * The model id in what you pasted: `deepseek/deepseek-v4.1-flash-1017`, `openrouter:…`, or a
 * link like `https://openrouter.ai/nousresearch/hermes-4-405b`. Null when it is neither.
 */
export function parseOpenRouterModel(input: string): string | null {
  let s = input.trim();
  if (s.startsWith(OPENROUTER_PREFIX)) s = s.slice(OPENROUTER_PREFIX.length);
  const url = /^https?:\/\/(?:www\.)?openrouter\.ai\/(?:models\/)?([^?#]+)/i.exec(s);
  if (url) s = decodeURIComponent(url[1]!).replace(/\/+$/, '').replace(/\/(api|providers|activity|apps|uptime)$/i, '');
  return OPENROUTER_SLUG.test(s) ? s.toLowerCase() : null;
}

/** The models OpenRouter offers at first, before you change the list. */
export const DEFAULT_OPENROUTER_MODELS = ['deepseek/deepseek-v4.1-flash-1017', 'nousresearch/hermes-4-405b'];

/**
 * OpenRouter: other models (DeepSeek, Hermes, GPT, Gemini…) inside Claude Code sessions. The
 * API key lives in Orbit's secrets file, never here.
 */
/** Longest master prompt for one OpenRouter model or Hugging Face endpoint. */
export const MAX_MODEL_INSTRUCTIONS = 40_000;

/** Your Hugging Face endpoints: only your instructions per endpoint live here (the token is a secret). */
const HuggingFaceSettings = z.object({
  instructions: z.record(z.string(), z.string().max(MAX_MODEL_INSTRUCTIONS)).default({}),
});

const OpenRouterSettings = z.object({
  models: z.array(z.string().trim().regex(OPENROUTER_SLUG)).max(30).default(DEFAULT_OPENROUTER_MODELS),
  /** Your own instructions per model (by its id), added to its system prompt in every session. */
  instructions: z.record(z.string(), z.string().max(MAX_MODEL_INSTRUCTIONS)).default({}),
});

const OnboardingSettings = z.object({
  completedAt: z.string().nullable().default(null),
});

export const SettingsSchema = z.object({
  execution: ExecutionSettings.prefault({}),
  models: ModelSettings.prefault({}),
  efforts: EffortSettings.prefault({}),
  codexModels: CodexModelSettings.prefault({}),
  team: TeamSettings.prefault({}),
  approvals: ApprovalSettings.prefault({}),
  asana: AsanaSettings.prefault({}),
  github: GitHubSettings.prefault({}),
  openrouter: OpenRouterSettings.prefault({}),
  huggingface: HuggingFaceSettings.prefault({}),
  onboarding: OnboardingSettings.prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

const section = z.record(z.string(), z.unknown()).optional();

/** Shape check for PATCH bodies. Values are validated by `mergeSettings`. */
export const SettingsPatchSchema = z
  .object({
    execution: section,
    models: section,
    efforts: section,
    codexModels: section,
    team: section,
    approvals: section,
    asana: section,
    github: section,
    openrouter: section,
    huggingface: section,
    onboarding: section,
  })
  .strict();

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Applies a partial patch and validates the full result. Throws a ZodError on invalid values. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    execution: { ...current.execution, ...defined(patch.execution) },
    models: { ...current.models, ...defined(patch.models) },
    efforts: { ...current.efforts, ...defined(patch.efforts) },
    codexModels: { ...current.codexModels, ...defined(patch.codexModels) },
    team: { ...current.team, ...defined(patch.team) },
    approvals: { ...current.approvals, ...defined(patch.approvals) },
    asana: { ...current.asana, ...defined(patch.asana) },
    github: { ...current.github, ...defined(patch.github) },
    openrouter: { ...current.openrouter, ...defined(patch.openrouter) },
    huggingface: { ...current.huggingface, ...defined(patch.huggingface) },
    onboarding: { ...current.onboarding, ...defined(patch.onboarding) },
  });
}

/** Parses stored settings, falling back to defaults for anything invalid or missing. */
export function parseStoredSettings(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return defaultSettings();
}

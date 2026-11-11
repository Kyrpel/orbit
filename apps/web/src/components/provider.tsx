import { HF_PREFIX, isHfModel, isOpenRouterModel, KNOWN_MODELS, openRouterSlug } from '@orbit/shared';
import { cn } from '../lib/utils';

export type ProviderKey = 'claude' | 'codex' | 'openrouter' | 'huggingface' | 'scripted' | null | undefined;

export const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', openrouter: 'OpenRouter', huggingface: 'Hugging Face', scripted: 'Scripted' };
export const PROVIDER_TEXT: Record<string, string> = { claude: 'text-claude', codex: 'text-codex', openrouter: 'text-openrouter', huggingface: 'text-huggingface', scripted: 'text-dust' };

/** Who answered: `model` tells an OpenRouter answer apart (it runs in Claude Code, but it is not Claude). */
export function providerOfRuntime(runtime: string | null | undefined, model?: string | null): ProviderKey {
  if (!runtime) return null;
  if (isOpenRouterModel(model) || runtime.includes(':openrouter:')) return 'openrouter';
  if (isHfModel(model) || runtime.includes(`:${HF_PREFIX}`)) return 'huggingface';
  if (runtime === 'codex-cli') return 'codex';
  if (runtime === 'scripted') return 'scripted';
  return 'claude';
}

/** "Claude Sonnet 5.5" for known Claude ids, the raw id otherwise. */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  // `hf:my-endpoint` → "my-endpoint"
  if (model.startsWith(HF_PREFIX)) return model.slice(HF_PREFIX.length);
  // `openrouter:deepseek/deepseek-v4.1-flash-1017` → "deepseek-v4.1-flash-1017"
  if (isOpenRouterModel(model)) return openRouterSlug(model).split('/').pop() ?? model;
  return KNOWN_MODELS.find((m) => m.id === model)?.label ?? model;
}

/** A small "who is working" chip: provider colour dot, name, and the model if known. */
export function ProviderBadge({ provider, model, className, quiet }: { provider: ProviderKey; model?: string | null; className?: string; quiet?: boolean }) {
  if (!provider) return null;
  const name = PROVIDER_NAME[provider] ?? provider;
  const label = modelLabel(model);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-2xs', quiet ? 'text-dust' : 'text-chalk/85', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full bg-current', PROVIDER_TEXT[provider])} aria-hidden />
      <span className={cn('font-[600]', PROVIDER_TEXT[provider])}>{name}</span>
      {label && label !== name ? <span className="truncate text-dust">{label.replace(/^Claude /, '')}</span> : null}
    </span>
  );
}

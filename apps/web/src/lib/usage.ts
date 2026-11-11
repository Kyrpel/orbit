import type { ChatMessageDTO } from '@orbit/shared';

/*
  Small pure helpers for the session prompt: what /cost and /context print, the `@file` mention
  under the cursor, and which of your messages /rewind can go back to.
*/

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** /cost: what the answers in this session used. Claude reports money; Codex only tokens (plan usage). */
export function costLines(messages: ChatMessageDTO[]): string[] {
  const used = messages.filter((m) => m.role === 'assistant' && m.usage);
  if (!used.length) return ['No usage recorded yet: send a message first.'];
  let cost = 0;
  let priced = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const m of used) {
    const u = m.usage!;
    if (u.costUsd != null) {
      cost += u.costUsd;
      priced++;
    }
    input += u.inputTokens;
    output += u.outputTokens;
    cached += u.cacheReadTokens;
  }
  const lines = [`This session: ${used.length} ${used.length === 1 ? 'answer' : 'answers'}`];
  lines.push(priced ? `Reported cost: ${money(cost)}${priced < used.length ? ` (${priced} of ${used.length} answers report a price)` : ''}` : 'Cost: not reported by the runtime');
  lines.push(`Tokens: ${formatTokens(input)} in · ${formatTokens(output)} out${cached ? ` · ${formatTokens(cached)} read from cache` : ''}`);
  return lines;
}

/** /context: how full the agent's context was after its last answer. */
export function contextLines(messages: ChatMessageDTO[]): string[] {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage?.contextTokens != null);
  const u = last?.usage;
  if (!u || u.contextTokens == null) return ['No context size recorded yet: send a message first.'];
  if (!u.contextWindow) return [`Context: ${formatTokens(u.contextTokens)} tokens after the last answer (this model's window is not known).`];
  const pct = Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100));
  const filled = Math.round(pct / 10);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  const lines = [`Context: ${bar} ${formatTokens(u.contextTokens)} of ${formatTokens(u.contextWindow)} tokens (${pct}%) after the last answer`];
  if (pct >= 70) lines.push('It is getting full: /compact summarizes the session and frees room.');
  return lines;
}

/** The `@mention` the cursor is in (`@src/ca|`), or null. */
export function mentionAt(value: string, caret: number): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? { query: m[2] ?? '', start: caret - (m[2] ?? '').length - 1 } : null;
}

/** Puts a chosen file or folder in place of the `@mention` being typed; a folder keeps the cursor inside it. */
export function applyMention(value: string, caret: number, mention: { query: string; start: number }, picked: string): { value: string; caret: number } {
  const isFolder = picked.endsWith('/');
  const insert = `@${picked}${isFolder ? '' : ' '}`;
  const after = value.slice(caret);
  const text = `${value.slice(0, mention.start)}${insert}${after}`;
  return { value: text, caret: mention.start + insert.length };
}

/** Your messages /rewind can go back to, newest first (not the ones that were folded into an answer). */
export function rewindTargets(messages: ChatMessageDTO[]): { id: string; text: string; checkpoint: boolean }[] {
  return messages
    .filter((m) => m.role === 'user' && m.status !== 'steered' && m.status !== 'queued')
    .map((m) => ({ id: m.id, text: m.content.replace(/\s+/g, ' ').trim(), checkpoint: m.checkpoint }))
    .reverse();
}

/** The latest agent answer is a finished plan, waiting for your OK (plan mode). */
export function planAwaitingApproval(mode: string, messages: ChatMessageDTO[]): ChatMessageDTO | null {
  if (mode !== 'plan') return null;
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' && last.kind === 'plan' && last.status === 'done' && last.content.trim() ? last : null;
}

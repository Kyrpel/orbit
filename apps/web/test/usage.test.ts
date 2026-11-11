import { describe, expect, it } from 'vitest';
import type { ChatMessageDTO, ChatUsageDTO } from '@orbit/shared';
import { applyMention, contextLines, costLines, formatTokens, mentionAt, planAwaitingApproval, rewindTargets } from '../src/lib/usage';

function msg(over: Partial<ChatMessageDTO>): ChatMessageDTO {
  return { id: 'm', conversationId: 'c', role: 'assistant', content: 'x', status: 'done', runtime: null, model: null, error: null, suggestion: null, blocked: [], attachments: [], kind: 'chat', usage: null, checkpoint: false, durationMs: null, createdAt: '2026-01-01T00:00:00Z', finishedAt: null, ...over };
}
const usage = (over: Partial<ChatUsageDTO>): ChatUsageDTO => ({ costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: null, contextWindow: null, ...over });

describe('/cost and /context', () => {
  it('formats token counts', () => {
    expect([999, 1234, 15_400, 2_500_000, 20_000_000].map(formatTokens)).toEqual(['999', '1.2k', '15k', '2.5M', '20M']);
  });

  it('adds up what the answers used, with a price only for those that report one', () => {
    expect(costLines([msg({ role: 'user' })])).toEqual(['No usage recorded yet: send a message first.']);
    const claude = costLines([msg({ usage: usage({ costUsd: 0.0123, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000 }) }), msg({ usage: usage({ costUsd: 0.5, inputTokens: 2000, outputTokens: 300 }) })]);
    expect(claude).toEqual(['This session: 2 answers', 'Reported cost: $0.51', 'Tokens: 3.0k in · 500 out · 4.0k read from cache']);
    const codex = costLines([msg({ usage: usage({ inputTokens: 900, outputTokens: 100 }) })]);
    expect(codex[1]).toContain('not reported');
    const mixed = costLines([msg({ usage: usage({ costUsd: 0.2 }) }), msg({ usage: usage({}) })]);
    expect(mixed[1]).toContain('1 of 2 answers report a price');
  });

  it('shows how full the context is after the last answer, and nudges toward /compact', () => {
    expect(contextLines([])).toEqual(['No context size recorded yet: send a message first.']);
    expect(contextLines([msg({ usage: usage({ contextTokens: 42_000, contextWindow: 200_000 }) })])).toEqual(['Context: ██░░░░░░░░ 42k of 200k tokens (21%) after the last answer']);
    const full = contextLines([msg({ usage: usage({ contextTokens: 160_000, contextWindow: 200_000 }) })]);
    expect(full).toHaveLength(2);
    expect(full[1]).toContain('/compact');
    expect(contextLines([msg({ usage: usage({ contextTokens: 5000 }) })])[0]).toContain('window is not known');
    // The newest answer with a size wins.
    expect(contextLines([msg({ usage: usage({ contextTokens: 1000, contextWindow: 1000 }) }), msg({ usage: usage({ contextTokens: 100, contextWindow: 1000 }) })])[0]).toContain('(10%)');
  });
});

describe('@ mentions', () => {
  it('finds the mention under the cursor, only at a word start', () => {
    expect(mentionAt('look at @src/ca', 15)).toEqual({ query: 'src/ca', start: 8 });
    expect(mentionAt('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('look at @src/cart.ts and more', 20)).toEqual({ query: 'src/cart.ts', start: 8 });
    expect(mentionAt('look at @src/cart.ts and more', 25)).toBeNull();
  });

  it('puts the chosen file in place, with a space after a file and none after a folder', () => {
    const m = { query: 'src/ca', start: 8 };
    expect(applyMention('look at @src/ca please', 15, m, 'src/cart.ts')).toEqual({ value: 'look at @src/cart.ts  please', caret: 21 });
    expect(applyMention('look at @src/ca', 15, m, 'src/checkout/')).toEqual({ value: 'look at @src/checkout/', caret: 22 });
  });
});

describe('/rewind targets and plan approval', () => {
  it('lists your own messages newest first, without ones folded into an answer', () => {
    const list = rewindTargets([
      msg({ id: 'u1', role: 'user', content: 'first', checkpoint: true }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user', content: 'sent  while\nworking', status: 'steered' }),
      msg({ id: 'u3', role: 'user', content: 'third', checkpoint: false }),
      msg({ id: 'u4', role: 'user', content: 'queued', status: 'queued' }),
    ]);
    expect(list).toEqual([
      { id: 'u3', text: 'third', checkpoint: false },
      { id: 'u1', text: 'first', checkpoint: true },
    ]);
  });

  it('asks for approval only after a finished plan-mode answer', () => {
    const done = msg({ id: 'a', kind: 'plan', content: 'The plan: 1. …' });
    expect(planAwaitingApproval('plan', [msg({ role: 'user' }), done])).toBe(done);
    expect(planAwaitingApproval('auto', [done])).toBeNull();
    expect(planAwaitingApproval('read-only', [done])).toBeNull();
    expect(planAwaitingApproval('plan', [msg({ kind: 'chat' })])).toBeNull();
    expect(planAwaitingApproval('plan', [msg({ role: 'user' })])).toBeNull();
    expect(planAwaitingApproval('plan', [msg({ status: 'running', content: '' })])).toBeNull();
    expect(planAwaitingApproval('plan', [msg({ kind: 'shell' })])).toBeNull();
  });
});

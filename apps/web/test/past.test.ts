import { describe, expect, it } from 'vitest';
import type { PastSessionDTO } from '@orbit/shared';
import { folderName, pastHint, pastToken, splitPastRefs } from '../src/lib/past';

describe('@past references in messages', () => {
  it('splits text and references, for showing them as labels', () => {
    expect(splitPastRefs('like @past:claude/1A2B3C4D, and @past:codex/0a0b0c0d-eeee please')).toEqual([
      'like ',
      { ref: 'claude/1a2b3c4d', source: 'claude', short: '1a2b3c4d' },
      ', and ',
      { ref: 'codex/0a0b0c0d-eeee', source: 'codex', short: '0a0b0c0d' },
      ' please',
    ]);
    expect(splitPastRefs('no references, @past:other/123456 stays text')).toEqual(['no references, @past:other/123456 stays text']);
  });

  it('describes a session in one short line', () => {
    const s: PastSessionDTO = { ref: 'claude/1a2b3c4d', source: 'claude', id: '1a2b3c4d-1', title: 'Badges', firstMessage: null, cwd: 'C:\\Users\\me\\Documents\\Events\\', repoId: null, messages: 1, startedAt: null, updatedAt: null };
    expect(pastHint(s)).toBe('Claude Code · Events · 1 message');
    expect(pastHint({ ...s, source: 'codex', messages: 4 }, { folder: false })).toBe('Codex · 4 messages');
    expect(folderName('/home/me/shop-api')).toBe('shop-api');
    expect(folderName(null)).toBe('unknown folder');
    expect(pastToken(s)).toBe('@past:claude/1a2b3c4d');
  });
});

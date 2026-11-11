import type { PastSessionDTO } from '@orbit/shared';
import { timeAgo } from './utils';

/*
  `@past:claude/1a2b3c4d` in a message points the agent at one of your Claude Code or Codex
  sessions from outside Orbit; Orbit sends that session's transcript with the message.
*/

export type PastPart = string | { ref: string; source: 'claude' | 'codex'; short: string };

/** Splits a message into text and `@past:` references, for showing them as chips. */
export function splitPastRefs(text: string): PastPart[] {
  const out: PastPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/@past:((claude|codex)\/([0-9a-f-]{6,64}))/gi)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ ref: m[1]!.toLowerCase(), source: m[2]!.toLowerCase() as 'claude' | 'codex', short: m[3]!.slice(0, 8).toLowerCase() });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const pastTool = (source: 'claude' | 'codex') => (source === 'claude' ? 'Claude Code' : 'Codex');

/** The last part of a folder path: `C:\code\shop-api` → `shop-api`. */
export function folderName(cwd: string | null): string {
  if (!cwd) return 'unknown folder';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** One line under a session's title in the pickers. */
export function pastHint(s: PastSessionDTO, opts: { folder?: boolean } = {}): string {
  const bits = [pastTool(s.source)];
  if (opts.folder !== false) bits.push(folderName(s.cwd));
  if (s.updatedAt) bits.push(timeAgo(s.updatedAt));
  bits.push(`${s.messages} ${s.messages === 1 ? 'message' : 'messages'}`);
  return bits.join(' · ');
}

/** The token a picked session becomes in the prompt. */
export const pastToken = (s: Pick<PastSessionDTO, 'ref'>) => `@past:${s.ref}`;

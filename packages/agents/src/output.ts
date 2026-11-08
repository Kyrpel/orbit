import { redactSecrets, type StepOutput } from '@orbit/shared';

/*
  Short, redacted previews of what a step produced, for the terminal view's `⎿` lines.
  Only the start of an output is kept (never whole files), so the event log stays small
  and a file the agent reads is summarised as a line count, not stored.
*/

const KEEP_LINES = 4;
const MAX_LINE = 220;
const MAX_DIFF = 40;

const clip = (line: string) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line);
const linesOf = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');

/** The first lines of some output, and how many lines it had in total. */
export function outputPreview(raw: string, keep = KEEP_LINES): StepOutput {
  const text = redactSecrets(raw.replace(/\r\n?/g, '\n')).replace(/\s+$/, '');
  if (!text.trim()) return { text: '(No output)' };
  const lines = linesOf(text);
  return { text: lines.slice(0, keep).map(clip).join('\n'), ...(lines.length > keep ? { lines: lines.length } : {}) };
}

function capDiff(lines: string[], added: number, removed: number): StepOutput {
  const red = redactSecrets(lines.join('\n')).split('\n');
  return { diff: red.slice(0, MAX_DIFF).map(clip), added, removed, ...(red.length > MAX_DIFF ? { lines: red.length } : {}) };
}

/** A line diff between two snippets; lines they share at the edges become context. */
export function snippetDiff(before: string, after: string): StepOutput {
  const a = before ? linesOf(before) : [];
  const b = after ? linesOf(after) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const diff = [
    ...a.slice(Math.max(0, start - 2), start).map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...a.slice(endA, endA + 2).map((l) => ` ${l}`),
  ];
  return capDiff(diff, added.length, removed.length);
}

/** A new file's content, as added lines. */
export function addedFile(content: string): StepOutput {
  const lines = content ? linesOf(content) : [];
  return capDiff(lines.map((l) => `+${l}`), lines.length, 0);
}

/** The lines of a unified diff (Codex file changes), without its headers. */
export function unifiedDiff(diff: string): StepOutput {
  const lines = diff
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l !== '' && !/^(---|\+\+\+|@@|diff |index |\\ No newline)/.test(l));
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  return capDiff(lines, added, removed);
}

/** What an edit will change, from the tool's own input (Claude's Edit, MultiEdit and Write). */
export function editPreview(tool: string, input: unknown): StepOutput | undefined {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') return snippetDiff(i.old_string, i.new_string);
  if (tool === 'MultiEdit' && Array.isArray(i.edits)) {
    const parts = (i.edits as Record<string, unknown>[])
      .filter((e) => e && typeof e.old_string === 'string' && typeof e.new_string === 'string')
      .map((e) => snippetDiff(e.old_string as string, e.new_string as string));
    if (!parts.length) return undefined;
    const lines = parts.flatMap((p, n) => (n ? [' …', ...(p.diff ?? [])] : (p.diff ?? [])));
    return capDiff(lines, parts.reduce((s, p) => s + (p.added ?? 0), 0), parts.reduce((s, p) => s + (p.removed ?? 0), 0));
  }
  if (tool === 'Write' && typeof i.content === 'string') return addedFile(i.content);
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  }
  return '';
}

/**
 * What a successful Claude tool call returned, condensed the way Claude Code prints it:
 * `Read 120 lines`, `Found 3 files`, or the first lines of a command's output.
 */
export function resultPreview(tool: string | undefined, content: unknown): StepOutput | undefined {
  if (!tool) return undefined;
  const text = contentText(content);
  const count = text.trim() ? linesOf(text).length : 0;
  switch (tool) {
    case 'Read':
      return { text: `Read ${count} ${count === 1 ? 'line' : 'lines'}` };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'TodoWrite':
      return undefined;
    case 'Glob':
      return { text: !count || /^No files found/i.test(text.trim()) ? 'No files found' : `Found ${count} ${count === 1 ? 'file' : 'files'}` };
    case 'Grep': {
      const first = text.trim().split('\n')[0] ?? '';
      return { text: /^(Found|No (files|matches))/i.test(first) ? clip(first) : `Found ${count} ${count === 1 ? 'line' : 'lines'}` };
    }
    case 'LS':
      return { text: `Listed ${count} ${count === 1 ? 'path' : 'paths'}` };
    case 'WebFetch':
    case 'WebSearch':
      return { text: `Received ${(text.length / 1024).toFixed(1)} KB` };
    default:
      return outputPreview(text);
  }
}

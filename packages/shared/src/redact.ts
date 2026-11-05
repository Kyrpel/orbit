/**
 * Secret redaction. Applied to everything Orbit persists or sends outward:
 * mission events, agent output, command output, Asana comments, PR bodies
 * and receipts.
 *
 * Two layers:
 *  1. Exact values Orbit knows are secret (tokens it loaded), registered at runtime.
 *  2. High-confidence token patterns from common providers.
 */

const knownSecrets = new Set<string>();

/** Registers a secret value so that any later output containing it is redacted. */
export function registerSecret(value: string | null | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  // Very short values would cause false positives everywhere.
  if (trimmed.length >= 8) knownSecrets.add(trimmed);
}

export function unregisterSecret(value: string | null | undefined): void {
  if (value) knownSecrets.delete(value.trim());
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, '[REDACTED API KEY]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\b[0-9]\/[0-9]{6,}(?:\/[0-9]{6,})?:[A-Za-z0-9]{16,}\b/g, '[REDACTED ASANA TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/(authorization:\s*(?:bearer|token|basic)\s+)[^\s"'`]+/gi, '$1[REDACTED]'],
  [/(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*\s*=\s*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"'`]{6,})/g, '$1[REDACTED]'],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Recursively redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /token|secret|password|api[_-]?key|authorization/i.test(k) && typeof v === 'string' ? '[REDACTED]' : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

export function containsKnownSecret(input: string): boolean {
  for (const secret of knownSecrets) if (input.includes(secret)) return true;
  return false;
}

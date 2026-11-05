import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Local API authentication. Orbit binds to 127.0.0.1 and additionally requires
 * a random token (stored in ORBIT_HOME/auth.json, readable only by you) on every
 * API call: the CLI and MCP bridge send it as a bearer token, the dashboard gets
 * it once through a login link and keeps it in an HttpOnly SameSite=Strict cookie.
 */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: string };
      if (parsed.token && parsed.token.length >= 32) return parsed.token;
    } catch {
      /* regenerate */
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return token;
}

export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Host header check: blocks DNS-rebinding pages that resolve their own domain to 127.0.0.1. */
export function isAllowedHost(hostHeader: string | undefined, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : (hostHeader.split(':')[0] ?? '');
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || extra.map((e) => e.toLowerCase()).includes(h);
}

export function isAllowedOrigin(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return isAllowedHost(u.host, extra);
  } catch {
    return false;
  }
}

export const SESSION_COOKIE = 'orbit_session';

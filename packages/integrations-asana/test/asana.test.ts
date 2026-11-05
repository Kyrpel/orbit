import { describe, expect, it } from 'vitest';
import { ProviderError } from '@orbit/integrations';
import { AsanaClient, AsanaProvider, SyncTokenExpiredError } from '../src';

type Handler = (url: URL, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> };

/** Mocked Asana API. These tests never reach the real service. */
function mockFetch(handler: Handler) {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const r = handler(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

function client(handler: Handler) {
  const m = mockFetch(handler);
  return { c: new AsanaClient({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep }), calls: m.calls };
}

describe('AsanaClient errors', () => {
  it('maps 401 to an auth error', async () => {
    const { c } = client(() => ({ status: 401, body: { errors: [{ message: 'Not Authorized' }] } }));
    await expect(c.getMe()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps 403 to forbidden', async () => {
    const { c } = client(() => ({ status: 403, body: { errors: [{ message: 'Forbidden' }] } }));
    await expect(c.getTask('1')).rejects.toBeInstanceOf(ProviderError);
    await expect(c.getTask('1')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('retries 429 using Retry-After, then succeeds', async () => {
    let n = 0;
    const slept: number[] = [];
    const m = mockFetch(() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '7' }, body: { errors: [{ message: 'Rate limited' }] } } : { status: 200, body: { data: { gid: '42', name: 'Me' } } }));
    const c = new AsanaClient({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: async (ms) => void slept.push(ms) });
    await expect(c.getMe()).resolves.toMatchObject({ gid: '42' });
    expect(slept.some((ms) => ms >= 7000)).toBe(true);
  });

  it('gives up on persistent 429 with a rate_limited error', async () => {
    const { c } = client(() => ({ status: 429, headers: { 'retry-after': '1' }, body: {} }));
    await expect(c.getMe()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSec: 1 });
  });

  it('retries 5xx with backoff', async () => {
    let n = 0;
    const { c } = client(() => (n++ < 2 ? { status: 503, body: {} } : { status: 200, body: { data: [{ gid: 'w1', name: 'Acme' }] } }));
    await expect(c.listWorkspaces()).resolves.toEqual([{ gid: 'w1', name: 'Acme' }]);
  });

  it('surfaces 412 on events as a fresh sync token', async () => {
    const { c } = client(() => ({ status: 412, body: { errors: [{ message: 'Sync token invalid or too old' }], sync: 'fresh-token' } }));
    await expect(c.getEvents('p1', 'old')).rejects.toBeInstanceOf(SyncTokenExpiredError);
    await expect(c.initialSyncToken('p1')).resolves.toBe('fresh-token');
  });

  it('follows offset pagination', async () => {
    const { c, calls } = client((url) =>
      url.searchParams.get('offset') ? { status: 200, body: { data: [{ gid: '3', name: 'c' }], next_page: null } } : { status: 200, body: { data: [{ gid: '1', name: 'a' }, { gid: '2', name: 'b' }], next_page: { offset: 'abc' } } },
    );
    const items = await c.listWorkspaces();
    expect(items.map((i) => i.gid)).toEqual(['1', '2', '3']);
    expect(calls[1]?.url.searchParams.get('offset')).toBe('abc');
  });
});

describe('AsanaProvider.pollTriggers', () => {
  const story = (gid: string, text: string, user = { gid: 'u1', name: 'Dev' }, type = 'comment') => ({ gid, text, created_at: '2026-11-04T10:00:00.000Z', created_by: user, type, resource_subtype: 'comment_added' });

  it('establishes a sync token on first poll without executing history', async () => {
    const m = mockFetch(() => ({ status: 412, body: { sync: 'first' } }));
    const p = new AsanaProvider({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep });
    const r = await p.pollTriggers('p1', { syncToken: null, lastPolledAt: null, lastEventAt: null, lastReconciledAt: null });
    expect(r.triggers).toHaveLength(0);
    expect(r.state.syncToken).toBe('first');
  });

  it('turns comment events into trigger candidates and ignores other comments', async () => {
    const m = mockFetch((url) => {
      if (url.pathname.endsWith('/events')) {
        return {
          status: 200,
          body: {
            sync: 'next',
            has_more: false,
            data: [
              { action: 'added', created_at: '2026-11-04T10:00:00Z', user: { gid: 'u1' }, resource: { gid: 's1', resource_type: 'story', resource_subtype: 'comment_added' }, parent: { gid: 't1', resource_type: 'task' } },
              { action: 'added', created_at: '2026-11-04T10:00:01Z', user: { gid: 'u1' }, resource: { gid: 's2', resource_type: 'story', resource_subtype: 'comment_added' }, parent: { gid: 't1', resource_type: 'task' } },
              { action: 'changed', created_at: '2026-11-04T10:00:02Z', user: { gid: 'u1' }, resource: { gid: 't2', resource_type: 'task' }, parent: null, change: { field: 'notes', action: 'changed' } },
            ],
          },
        };
      }
      if (url.pathname.endsWith('/stories/s1')) return { status: 200, body: { data: story('s1', '/orbit run\nKeep it small') } };
      if (url.pathname.endsWith('/stories/s2')) return { status: 200, body: { data: story('s2', 'looks good to me') } };
      return { status: 404, body: {} };
    });
    const p = new AsanaProvider({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep });
    const r = await p.pollTriggers('p1', { syncToken: 'cur', lastPolledAt: null, lastEventAt: null, lastReconciledAt: null });
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]).toMatchObject({ dedupeKey: 'asana:story:s1', taskId: 't1', command: 'run', extraInstructions: 'Keep it small', author: { id: 'u1' } });
    expect(r.taskChanges).toEqual([{ taskId: 't2', kind: 'changed' }]);
    expect(r.state.syncToken).toBe('next');
  });

  it('reconciles recent tasks when the sync token expired', async () => {
    const m = mockFetch((url) => {
      if (url.pathname.endsWith('/events')) return { status: 412, body: { sync: 'renewed' } };
      if (url.pathname.endsWith('/projects/p1/tasks')) return { status: 200, body: { data: [{ gid: 't9', name: 'Task', modified_at: '2026-11-04T09:00:00Z' }] } };
      if (url.pathname.endsWith('/tasks/t9/stories')) return { status: 200, body: { data: [story('s9', '/orbit run'), story('s10', 'hello')] } };
      return { status: 404, body: {} };
    });
    const p = new AsanaProvider({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep });
    const r = await p.pollTriggers('p1', { syncToken: 'stale', lastPolledAt: '2026-11-04T08:00:00Z', lastEventAt: null, lastReconciledAt: null });
    expect(r.resynced).toBe(true);
    expect(r.reconciled).toBe(true);
    expect(r.state.syncToken).toBe('renewed');
    expect(r.triggers.map((t) => t.dedupeKey)).toEqual(['asana:story:s9']);
    expect(r.triggers[0]?.via).toBe('reconcile');
  });

  it('never treats comments Orbit posted as triggers', async () => {
    const m = mockFetch((url) => {
      if (url.pathname.endsWith('/events')) {
        return { status: 200, body: { sync: 'n', has_more: false, data: [{ action: 'added', created_at: 'x', user: null, resource: { gid: 'mine', resource_type: 'story' }, parent: { gid: 't1', resource_type: 'task' } }] } };
      }
      return { status: 200, body: { data: story('mine', '/orbit run') } };
    });
    const p = new AsanaProvider({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep });
    const r = await p.pollTriggers('p1', { syncToken: 'cur', lastPolledAt: null, lastEventAt: null, lastReconciledAt: null }, { ignoreCommentIds: new Set(['mine']) });
    expect(r.triggers).toHaveLength(0);
  });

  it('posts plain-text comments', async () => {
    const m = mockFetch((url, init) => (init.method === 'POST' ? { status: 201, body: { data: story('c1', 'hi') } } : { status: 404, body: {} }));
    const p = new AsanaProvider({ token: 'test-token-1234567890', fetch: m.fetchImpl, sleep: noSleep });
    await p.postComment('t1', 'Orbit update');
    expect(m.calls[0]?.url.pathname).toBe('/api/1.0/tasks/t1/stories');
    expect(m.calls[0]?.body).toEqual({ data: { text: 'Orbit update' } });
  });
});

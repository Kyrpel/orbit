import { Check, Plus, Terminal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CursorModelDTO, CursorStatusDTO } from '@orbit/shared';
import { keys, post, useAction } from '../lib/api';
import { InstructionsEditor } from './openrouter-card';
import { Button, Code, Input, Tag } from './ui';

/*
  Cursor on the Agents page: your Cursor subscription through the Cursor CLI. Pick which of your
  account's models are in a session's Model menu, and give each your own instructions.
*/

function ModelRow({ m, onRemove, removing }: { m: CursorModelDTO; onRemove: () => void; removing: boolean }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-[600]">{m.label}</span>
          {m.missing ? <Tag tone="danger">Not on your Cursor account</Tag> : null}
        </p>
        <p className="mt-0.5 text-2xs text-dust">
          <span className="mono">{m.slug}</span>
        </p>
        {!m.missing ? <InstructionsEditor id={`cursor-${m.slug}`} label={m.label} value={m.instructions} save={(t) => post('/api/cursor/models/instructions', { model: m.slug, instructions: t })} /> : null}
      </div>
      <button type="button" onClick={onRemove} disabled={removing} className="grid size-7 shrink-0 place-items-center rounded-[7px] text-dust hover:bg-hull-2 hover:text-chalk disabled:opacity-50" aria-label={`Remove ${m.slug}`} title="Remove from the Model menu">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

export function CursorCard({ status }: { status: CursorStatusDTO }) {
  const [query, setQuery] = useState('');
  const invalidate = [keys.team];
  const add = useAction((m: string) => post<CursorStatusDTO>('/api/cursor/models', { model: m }), { success: 'Added to the Model menu', invalidate });
  const remove = useAction((m: string) => post<CursorStatusDTO>('/api/cursor/models/remove', { model: m }), { invalidate });
  const chosen = new Set(status.models.map((m) => m.slug));
  // Your account offers hundreds of models: search them by name or id.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return status.catalog.filter((c) => !chosen.has(c.id) && (c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status.catalog, status.models]);

  return (
    <div className="rounded-[10px] border border-seam px-4 py-3 md:col-span-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-cursor" aria-hidden />
        <span className="font-[620]">Cursor</span>
        <span className="text-2xs text-dust">your Cursor subscription</span>
        {status.ready ? (
          <Tag tone="success" className="ml-auto">
            <Check className="size-3" aria-hidden /> Ready
          </Tag>
        ) : (
          <Tag tone="neutral" className="ml-auto">
            {status.installed ? 'Not signed in' : 'Not installed'}
          </Tag>
        )}
      </div>
      <p className="mt-1.5 max-w-[78ch] text-2xs text-dust">
        Choose Cursor as the AI in a session (or with /ai), then the model. Orbit runs Cursor's own agent with your Cursor login, so it uses your subscription and never your Claude or Codex plan. In Auto-accept, Cursor's own safety check decides which commands run; in Ask first you approve each new command.
      </p>

      {status.ready ? (
        <p className="mt-2 text-2xs text-dust">{status.version ? `Cursor Agent ${status.version}` : 'Cursor Agent'}, signed in.</p>
      ) : (
        <div className="mt-2 space-y-1.5 text-2xs text-dust">
          <p>{status.reason}</p>
          <p className="flex flex-wrap items-center gap-1.5">
            <Terminal className="size-3" aria-hidden />
            {status.installed ? (
              <>
                Sign in by typing <Code>! cursor-agent login</Code> in any session.
              </>
            ) : (
              <>
                Install it from <a href="https://cursor.com/cli" target="_blank" rel="noreferrer" className="text-telemetry hover:underline">cursor.com/cli</a>, then type <Code>! cursor-agent login</Code> in any session.
              </>
            )}
          </p>
        </div>
      )}

      {status.ready ? (
        <div className="mt-3 border-t border-seam pt-2">
          <p className="text-2xs font-[600] uppercase tracking-[0.04em] text-dust">Models you can pick</p>
          {status.models.length ? (
            <ul className="divide-y divide-seam">
              {status.models.map((m) => (
                <ModelRow key={m.slug} m={m} removing={remove.isPending} onRemove={() => remove.mutate(m.slug)} />
              ))}
            </ul>
          ) : (
            <p className="py-2 text-xs text-dust">No Cursor models in the menu yet.</p>
          )}
          <div className="relative mt-1 max-w-[460px]">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search your ${status.catalog.length} Cursor models: opus, gpt, grok, composer…`} aria-label="Search Cursor models to add" className="h-8 text-xs" />
            {matches.length ? (
              <ul className="absolute left-0 right-0 top-9 z-20 rounded-[8px] border border-seam bg-hull p-1 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.25)]">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => add.mutate(c.id, { onSuccess: () => setQuery('') })}
                      className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-xs hover:bg-hull-2"
                    >
                      <Plus className="size-3.5 text-dust" aria-hidden />
                      <span className="font-[600]">{c.label}</span>
                      <span className="mono ml-auto text-2xs text-dust">{c.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {query.trim() && !matches.length ? <p className="mt-1 text-2xs text-dust">No model matches (or it is already in the menu).</p> : null}
          {add.isPending ? (
            <Button size="sm" className="mt-1" loading disabled>
              Adding
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

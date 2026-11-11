import { Check, KeyRound, MessageSquareText, NotebookPen, Plus, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { MAX_MODEL_INSTRUCTIONS, type OpenRouterModelDTO, type OpenRouterStatusDTO } from '@orbit/shared';
import { del, keys, post, useAction } from '../lib/api';
import { Button, Input, Tag, Textarea } from './ui';

/*
  OpenRouter on the Agents page: connect a key, choose which of OpenRouter's models appear in
  a session's Model menu (DeepSeek, Hermes, GPT, Gemini…). They run inside Claude Code, with
  your OpenRouter key instead of your Claude login.
*/

/** A price: 0 is free. */
const money = (n: number) => (n === 0 ? 'free' : n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
/** An amount spent or a limit: 0 is $0.00. */
const dollars = (n: number) => `$${n.toFixed(2)}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`);

/** Your master prompt for one model: added to its system prompt in every session that uses it. */
export function InstructionsEditor({ id, label, value, save }: { id: string; label: string; value: string; save: (text: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const saving = useAction(save, {
    success: () => (text.trim() ? 'Instructions saved: they apply from the next message' : 'Instructions removed'),
    invalidate: [keys.team, ['huggingface']],
  });
  if (!open) {
    return value ? (
      <button type="button" onClick={() => (setText(value), setOpen(true))} className="mt-1.5 block w-full max-w-[78ch] rounded-[8px] border border-seam bg-hull-2 px-2.5 py-1.5 text-left text-2xs hover:border-seam-2" title="Edit the instructions">
        <span className="flex items-center gap-1 font-[600] text-chalk/90">
          <NotebookPen className="size-3" aria-hidden /> Your instructions
        </span>
        <span className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-dust">{value}</span>
      </button>
    ) : (
      <button type="button" onClick={() => (setText(''), setOpen(true))} className="mt-1 inline-flex items-center gap-1 text-2xs font-[600] text-telemetry hover:underline">
        <NotebookPen className="size-3" aria-hidden /> Add instructions
      </button>
    );
  }
  const over = text.length > MAX_MODEL_INSTRUCTIONS;
  return (
    <form
      className="mt-1.5 max-w-[78ch]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!over) saving.mutate(text, { onSuccess: () => setOpen(false) });
      }}
    >
      <label className="text-2xs text-dust" htmlFor={`instr-${id}`}>
        Instructions for {label}. They go into its system prompt in every session, on top of Orbit's own rules.
      </label>
      <Textarea
        id={`instr-${id}`}
        autoFocus
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'For example:\nAnswer in Greek.\nAlways show the full file after a change.\nPrefer small, readable functions.'}
        className="mt-1 text-xs"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" type="submit" loading={saving.isPending} disabled={over}>
          Save
        </Button>
        <Button size="sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {value ? (
          <button type="button" onClick={() => (setText(''), saving.mutate('', { onSuccess: () => setOpen(false) }))} className="text-2xs text-dust hover:text-fault">
            Remove instructions
          </button>
        ) : null}
        <span className={`ml-auto text-2xs ${over ? 'text-fault' : 'text-dust'}`}>
          {text.length.toLocaleString('en')} / {MAX_MODEL_INSTRUCTIONS.toLocaleString('en')}
        </span>
      </div>
    </form>
  );
}

function Instructions({ m }: { m: OpenRouterModelDTO }) {
  return <InstructionsEditor id={m.slug} label={m.name.replace(/^[^:]+:\s*/, '')} value={m.instructions} save={(t) => post('/api/openrouter/models/instructions', { model: m.slug, instructions: t })} />;
}

function ModelRow({ m, onRemove, removing }: { m: OpenRouterModelDTO; onRemove: () => void; removing: boolean }) {
  const facts = [
    m.contextLength ? `${tokens(m.contextLength)} context` : null,
    m.pricePerMillion ? `${money(m.pricePerMillion.input)} in · ${money(m.pricePerMillion.output)} out per million tokens` : null,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-[600]">{m.name.replace(/^[^:]+:\s*/, '')}</span>
          {m.missing ? (
            <Tag tone="danger">No longer on OpenRouter</Tag>
          ) : m.tools === false ? (
            <Tag tone="attention">
              <MessageSquareText className="size-3" aria-hidden /> Chat only
            </Tag>
          ) : m.tools ? (
            <Tag tone="success">
              <Wrench className="size-3" aria-hidden /> Can work in your project
            </Tag>
          ) : null}
        </p>
        <p className="mt-0.5 text-2xs text-dust">
          <span className="mono">{m.slug}</span>
          {facts.length ? ` · ${facts.join(' · ')}` : ''}
        </p>
        {m.tools === false && !m.missing ? (
          <p className="mt-1 max-w-[70ch] text-2xs text-dust">OpenRouter says this model cannot use tools, so in a session it only talks: it cannot read your files, run commands or make changes. Paste what it should look at.</p>
        ) : null}
        {!m.missing ? <Instructions m={m} /> : null}
      </div>
      <button type="button" onClick={onRemove} disabled={removing} className="grid size-7 shrink-0 place-items-center rounded-[7px] text-dust hover:bg-hull-2 hover:text-chalk disabled:opacity-50" aria-label={`Remove ${m.slug}`} title="Remove from the Model menu">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

export function OpenRouterCard({ status }: { status: OpenRouterStatusDTO }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const invalidate = [keys.team];
  const connect = useAction((k: string) => post<OpenRouterStatusDTO>('/api/openrouter/key', { key: k }), { success: 'OpenRouter connected', invalidate });
  const disconnect = useAction(() => del<OpenRouterStatusDTO>('/api/openrouter/key'), { success: 'OpenRouter disconnected', invalidate });
  const add = useAction((m: string) => post<OpenRouterStatusDTO>('/api/openrouter/models', { model: m }), { success: 'Added to the Model menu', invalidate });
  const remove = useAction((m: string) => post<OpenRouterStatusDTO>('/api/openrouter/models/remove', { model: m }), { invalidate });
  const acct = status.account;

  return (
    <div className="rounded-[10px] border border-seam px-4 py-3 md:col-span-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-openrouter" aria-hidden />
        <span className="font-[620]">OpenRouter</span>
        <span className="text-2xs text-dust">DeepSeek, Hermes and other models in your sessions</span>
        {status.connected ? (
          <Tag tone="success" className="ml-auto">
            <Check className="size-3" aria-hidden /> Connected
          </Tag>
        ) : (
          <Tag tone="neutral" className="ml-auto">
            Not connected
          </Tag>
        )}
      </div>
      <p className="mt-1.5 max-w-[78ch] text-2xs text-dust">
        In a session, choose OpenRouter as the AI (next to Auto, Claude and Codex, or with /ai), then pick the model. They run inside Claude Code's tools with your OpenRouter key, never your Claude login, and OpenRouter bills your credits. These models may handle Claude Code's tools less reliably than Claude does.
      </p>

      {status.connected ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-dust">
          <span className="inline-flex items-center gap-1">
            <KeyRound className="size-3" aria-hidden /> Key ending <span className="mono text-chalk">{status.keyHint}</span>
            {acct?.label ? ` (${acct.label})` : ''}
          </span>
          {acct?.usageUsd != null ? <span>{dollars(acct.usageUsd)} used{acct.limitUsd != null ? ` of ${dollars(acct.limitUsd)}` : ''}</span> : null}
          <button type="button" onClick={() => disconnect.mutate(undefined)} className="font-[600] text-chalk/80 underline-offset-2 hover:underline">
            Disconnect
          </button>
        </p>
      ) : (
        <form
          className="mt-2.5 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) connect.mutate(key.trim(), { onSuccess: () => setKey('') });
          }}
        >
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-v1-…" aria-label="OpenRouter API key" className="mono h-8 max-w-[340px] text-xs" />
          <Button size="sm" variant="primary" type="submit" loading={connect.isPending} disabled={!key.trim()}>
            Connect
          </Button>
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-2xs text-telemetry hover:underline">
            Get a key
          </a>
          <span className="w-full text-2xs text-dust">Orbit checks the key with OpenRouter and keeps it in its secrets file on this computer. It is only ever sent to OpenRouter.</span>
        </form>
      )}

      <div className="mt-3 border-t border-seam pt-2">
        <p className="text-2xs font-[600] uppercase tracking-[0.04em] text-dust">Models you can pick</p>
        {status.models.length ? (
          <ul className="divide-y divide-seam">
            {status.models.map((m) => (
              <ModelRow key={m.slug} m={m} removing={remove.isPending} onRemove={() => remove.mutate(m.slug)} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-dust">No OpenRouter models yet.</p>
        )}
        <form
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) add.mutate(model.trim(), { onSuccess: () => setModel('') });
          }}
        >
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="https://openrouter.ai/… or deepseek/deepseek-v4.1-flash-1017" aria-label="OpenRouter model to add" className="h-8 max-w-[420px] text-xs" />
          <Button size="sm" type="submit" loading={add.isPending} disabled={!model.trim()}>
            <Plus className="size-3.5" aria-hidden /> Add model
          </Button>
        </form>
      </div>
    </div>
  );
}

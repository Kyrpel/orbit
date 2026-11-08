import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * A small Markdown renderer for Assistant answers. It builds React elements
 * (never raw HTML), so model output cannot inject markup or scripts. Supports
 * what answers about code need: headings, paragraphs, lists, quotes, fenced
 * code, inline code, bold, italics and http(s) links.
 */

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-3 overflow-hidden rounded-[8px] border border-seam bg-night">
      <div className="flex items-center justify-between border-b border-seam px-3 py-1 text-2xs text-dust-2">
        <span className="mono">{lang || 'code'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-dust hover:text-chalk"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mono overflow-x-auto p-3 text-[12.5px] leading-5 text-chalk/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Links come first because their labels often contain `code`.
const INLINE = /(\[[^\]\n]+\]\(([^)\s]+)\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;

/** `term`: the terminal look (inline code as coloured text, as Claude Code prints it). */
export function renderInline(text: string, keyPrefix = 'i', term = false): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      const label = tok.slice(1, tok.indexOf(']('));
      const href = m[2] ?? '';
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className={term ? 't-perm underline underline-offset-2' : 'text-telemetry underline decoration-telemetry/40 underline-offset-2 hover:decoration-telemetry'}>
            {renderInline(label, key, term)}
          </a>,
        );
      } else {
        // Local file paths and other targets: show the label, keep the target as a tooltip.
        out.push(
          <span key={key} title={href}>
            {renderInline(label, key, term)}
          </span>,
        );
      }
    } else if (m[3]) {
      out.push(
        term ? (
          <code key={key} className="t-code">
            {tok.slice(1, -1)}
          </code>
        ) : (
          <code key={key} className="mono rounded-[4px] bg-hull-3 px-1 py-px text-[0.86em] text-chalk">
            {tok.slice(1, -1)}
          </code>
        ),
      );
    } else if (m[4] || m[5]) out.push(<strong key={key} className={term ? 'font-bold' : 'font-[640] text-chalk'}>{renderInline(tok.slice(2, -2), key, term)}</strong>);
    else if (m[6] || m[7]) out.push(<em key={key}>{renderInline(tok.slice(1, -1), key, term)}</em>);
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'rule' }
  | { type: 'para'; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ type: 'code', lang: fence[1] ?? '', code: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const re = isOrdered ? ordered : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        if (re.test(lines[i]!)) items.push(lines[i]!.replace(re, ''));
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const row = lines[i++]!.trim();
        // The |---|:---:| line under the header carries no content.
        if (/^\|[\s:|-]+\|$/.test(row)) continue;
        rows.push(row.slice(1, -1).split('|').map((c) => c.trim()));
      }
      blocks.push({ type: 'table', rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^#{1,4}\s/.test(lines[i]!) && !bullet.test(lines[i]!) && !ordered.test(lines[i]!) && !/^\s*>/.test(lines[i]!) && !/^\s*\|.*\|\s*$/.test(lines[i]!)) {
      para.push(lines[i++]!.trim());
    }
    blocks.push({ type: 'para', text: para.join(' ') });
  }
  return blocks;
}

/** The terminal look: one size, bold headings, plain code blocks, like Claude Code's output. */
function TerminalMarkdown({ blocks, className }: { blocks: Block[]; className?: string }) {
  return (
    <div className={cn('space-y-[0.6em] break-words', className)}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case 'code':
            return (
              <pre key={k} className="overflow-x-auto whitespace-pre pl-[2ch] t-fg">
                <code>{b.code}</code>
              </pre>
            );
          case 'heading':
            return (
              <p key={k} className={cn('font-bold', b.level <= 2 && 'underline underline-offset-4')}>
                {renderInline(b.text, k, true)}
              </p>
            );
          case 'list':
            return (
              <div key={k}>
                {b.items.map((it, j) => (
                  <div key={j} className="grid grid-cols-[3ch_minmax(0,1fr)]">
                    <span className="t-dim">{b.ordered ? `${j + 1}.` : '-'}</span>
                    <span>{renderInline(it, `${k}-${j}`, true)}</span>
                  </div>
                ))}
              </div>
            );
          case 'quote':
            return (
              <p key={k} className="grid grid-cols-[2ch_minmax(0,1fr)] italic t-dim">
                <span aria-hidden>▎</span>
                <span>{renderInline(b.text, k, true)}</span>
              </p>
            );
          case 'table':
            return (
              <div key={k} className="overflow-x-auto">
                <table className="border-collapse">
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} className={cn('border t-sep px-[1ch] align-top', r === 0 && 'font-bold')}>
                            {renderInline(cell, `${k}-${r}-${c}`, true)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return (
              <p key={k} className="overflow-hidden whitespace-nowrap t-faint" aria-hidden>
                {'─'.repeat(60)}
              </p>
            );
          default:
            return <p key={k}>{renderInline(b.text, k, true)}</p>;
        }
      })}
    </div>
  );
}

export function Markdown({ text, className, variant = 'default' }: { text: string; className?: string; variant?: 'default' | 'terminal' }) {
  const blocks = parseBlocks(text);
  if (variant === 'terminal') return <TerminalMarkdown blocks={blocks} className={className} />;
  return (
    <div className={cn('text-[14.5px] leading-7 text-chalk/90', className)}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case 'code':
            return <CodeBlock key={k} code={b.code} lang={b.lang} />;
          case 'heading':
            return (
              <p key={k} className={cn('mb-1 mt-4 font-[640] text-chalk first:mt-0', b.level <= 2 ? 'text-base' : 'text-[14.5px]')}>
                {renderInline(b.text, k)}
              </p>
            );
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul';
            return (
              <List key={k} className={cn('my-2 space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc marker:text-dust-2')}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${k}-${j}`)}</li>
                ))}
              </List>
            );
          }
          case 'quote':
            return (
              <blockquote key={k} className="my-2 border-l-2 border-seam-2 pl-3 text-dust">
                {renderInline(b.text, k)}
              </blockquote>
            );
          case 'table':
            return (
              <div key={k} className="my-3 overflow-x-auto">
                <table className="border-collapse text-[13.5px]">
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className={r === 0 ? 'bg-hull-2 font-[600]' : undefined}>
                        {row.map((cell, c) => (
                          <td key={c} className="border border-seam px-2.5 py-1 align-top">
                            {renderInline(cell, `${k}-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={k} className="my-4 border-seam" />;
          default:
            return (
              <p key={k} className="my-2 first:mt-0 last:mb-0">
                {renderInline(b.text, k)}
              </p>
            );
        }
      })}
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../src/components/markdown';

describe('Markdown blocks', () => {
  it('parses the shapes Assistant answers use', () => {
    const blocks = parseBlocks(
      ['## Where totals live', 'Totals are computed in `src/cart.ts`', 'and rounded there.', '', '- one', '- two', '  continued', '1. first', '2. second', '> note', '```ts', 'const a = 1;', '```', '---'].join('\n'),
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: 'Where totals live' },
      { type: 'para', text: 'Totals are computed in `src/cart.ts` and rounded there.' },
      { type: 'list', ordered: false, items: ['one', 'two continued'] },
      { type: 'list', ordered: true, items: ['first', 'second'] },
      { type: 'quote', text: 'note' },
      { type: 'code', lang: 'ts', code: 'const a = 1;' },
      { type: 'rule' },
    ]);
  });

  it('keeps an unterminated code fence as code', () => {
    expect(parseBlocks('```\nhalf written')).toEqual([{ type: 'code', lang: '', code: 'half written' }]);
  });
});

describe('inline Markdown', () => {
  it('links only web addresses and shows local file links as their label', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement, Fragment } = await import('react');
    const { renderInline } = await import('../src/components/markdown');
    const html = (t: string) => renderToStaticMarkup(createElement(Fragment, null, ...renderInline(t)));
    expect(html('See [`a.ts`](C:/x/a.ts) now')).toBe('See <span title="C:/x/a.ts"><code class="mono rounded-[4px] bg-hull-3 px-1 py-px text-[0.86em] text-chalk">a.ts</code></span> now');
    expect(html('[docs](https://example.com)')).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener"');
    expect(html('[x](javascript:alert(1))')).not.toContain('<a');
    expect(html('**bold** and *it*')).toContain('<strong');
  });
});

import { describe, expect, it } from 'vitest';
import { expandPastes, imageToken, insertAt, lineCount, pasteToken, shouldFold, splitImageTokens, usedImages } from '../src/lib/paste';

describe('pasting into the prompt, as in Claude Code', () => {
  it('folds long pastes into a token and sends the full text', () => {
    const log = Array.from({ length: 42 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFold('one line')).toBe(false);
    expect(shouldFold('a\nb\nc')).toBe(false);
    expect(shouldFold(log)).toBe(true);
    expect(shouldFold('x'.repeat(900))).toBe(true);
    const p = { n: 1, text: log };
    expect(pasteToken(p)).toBe('[Pasted text #1 +42 lines]');
    expect(expandPastes(`Why does this fail? ${pasteToken(p)}`, [p])).toBe(`Why does this fail? ${log}`);
    // Deleting the token drops the paste.
    expect(expandPastes('Never mind', [p])).toBe('Never mind');
    expect(lineCount('a\r\nb\n')).toBe(2);
  });

  it('sends only the images whose token is still in the text', () => {
    const images = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(usedImages(`Compare ${imageToken(1)} with ${imageToken(3)}`, images).map((i) => i.n)).toEqual([1, 3]);
  });

  it('inserts tokens at the cursor with a space before them', () => {
    expect(insertAt('Look at', 7, 7, '[Image #1]')).toEqual({ value: 'Look at [Image #1]', caret: 18 });
    expect(insertAt('', 0, 0, '[Image #1]')).toEqual({ value: '[Image #1]', caret: 10 });
    expect(insertAt('a  b', 2, 2, 'X').value).toBe('a X b');
  });

  it('finds image tokens so they can link to their images', () => {
    expect(splitImageTokens('See [Image #1] and [Image #2].')).toEqual(['See ', { n: 1 }, ' and ', { n: 2 }, '.']);
    expect(splitImageTokens('no images')).toEqual(['no images']);
  });
});

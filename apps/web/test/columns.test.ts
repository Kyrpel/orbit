import { describe, expect, it } from 'vitest';
import { gridColumns } from '../src/lib/tabs';

describe('workspace columns side by side', () => {
  it('shows six terminals as 3 × 2 when you pick three columns', () => {
    expect(gridColumns(6, 1400, 3)).toBe(3);
    expect(gridColumns(4, 1400, 3)).toBe(3); // 3 + 1, the last pane fills its row
    expect(gridColumns(8, 1900, 4)).toBe(4);
    expect(gridColumns(6, 1400, 2)).toBe(2);
  });

  it('never makes more columns than panes, and one column on a narrow window', () => {
    expect(gridColumns(2, 1600, 3)).toBe(2);
    expect(gridColumns(1, 1600, 4)).toBe(1);
    expect(gridColumns(6, 700, 3)).toBe(1);
  });

  it('keeps the old automatic choice', () => {
    expect(gridColumns(4, 1600)).toBe(2);
    expect(gridColumns(6, 1400)).toBe(2);
    expect(gridColumns(6, 1600)).toBe(3);
    expect(gridColumns(3, 1600, 'auto')).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import { heatmap, lastNDays, levelOf, streak } from '../../src/study/heatmap';

const now = new Date(2026, 9, 28, 9, 0); // Wednesday 2026-10-28, 9:00

describe('study heatmap', () => {
  it('levels by minutes', () => {
    expect([0, 59, 60, 29 * 60, 30 * 60, 90 * 60, 179 * 60, 180 * 60, 600 * 60].map(levelOf)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4]);
  });
  it('lays out weeks Monday-first with the current week last', () => {
    const g = heatmap({ '2026-10-26': 3600, '2026-10-28': 60 }, now, 4);
    expect(g).toHaveLength(4);
    const cur = g[3];
    expect(cur[0].key).toBe('2026-10-26'); // Monday
    expect(cur[0].level).toBe(2);
    expect(cur[2].key).toBe('2026-10-28');
    expect(cur[2].future).toBe(false);
    expect(cur[3].future).toBe(true);
    expect(g[0][0].key).toBe('2026-10-05');
  });
  it('streak counts back from today, or from yesterday before studying today', () => {
    const d = { '2026-10-25': 900, '2026-10-26': 1200, '2026-10-27': 700 };
    expect(streak(d, now)).toBe(3); // today not yet
    expect(streak({ ...d, '2026-10-28': 800 }, now)).toBe(4);
    expect(streak({ ...d, '2026-10-26': 100 }, now)).toBe(1);
    expect(streak({}, now)).toBe(0);
  });
  it('sums the last days', () => {
    expect(lastNDays({ '2026-10-28': 60, '2026-10-22': 60, '2026-10-21': 60 }, 7, now)).toBe(120);
  });
});

import { describe, expect, it } from 'vitest';
import { addDay, pageDays, pagesByDate, problemAt, problemGroups, problemLabels, resultCounts } from '../../src/core/problems';
import type { Page } from '../../src/core/types';
import { mkStroke } from './helpers';

const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, nb: 'n', w: 100, h: 100, bg: { tpl: 'blank', spacing: 5, color: '#fff' }, strokes: [], items: [], updated: 0, ...extra });

describe('問題ごとのノート', () => {
  it('labels in the chosen style from the chosen number', () => {
    expect(problemLabels('mon', 1, 3)).toEqual(['問1', '問2', '問3']);
    expect(problemLabels('dai', 5, 2)).toEqual(['第5問', '第6問']);
    expect(problemLabels('n', 0, 2)).toEqual(['0', '1']);
    expect(problemLabels('rei', 1, 5000)).toHaveLength(1000);
  });

  it('consecutive pages of a problem are one board; its ○△× and whether it was written', () => {
    const pages = [
      page('a', { problem: '問1', result: 'o', strokes: [mkStroke([[1, 1, 0.5], [2, 2, 0.5]])] }),
      page('b', { problem: '問2' }),
      page('c', { problem: '問2', result: 'x' }),
      page('d', { problem: '問3' }),
    ];
    const g = problemGroups(pages);
    expect(g.map((x) => [x.label, x.pages, x.result, x.written])).toEqual([
      ['問1', [0], 'o', true],
      ['問2', [1, 2], 'x', false],
      ['問3', [3], undefined, false],
    ]);
    expect(resultCounts(g)).toEqual({ o: 1, d: 0, x: 1, todo: 1, total: 3 });
    expect(problemAt(pages, 2)).toEqual({ label: '問2', index: 1, total: 3, first: 1, last: 2, result: 'x' });
    expect(problemAt([page('z')], 0)).toBeNull();
  });
});

describe('日付とページ', () => {
  it('each page remembers the days it was written; date → pages, newest or oldest first', () => {
    const p1 = page('a'), p2 = page('b'), p3 = page('c');
    expect(addDay(p1, '2026-10-25')).toBe(true);
    expect(addDay(p1, '2026-10-25')).toBe(false);
    addDay(p1, '2026-10-27');
    addDay(p2, '2026-10-26');
    expect(pagesByDate([p1, p2, p3])).toEqual([
      { day: '2026-10-27', pages: [0] },
      { day: '2026-10-26', pages: [1] },
      { day: '2026-10-25', pages: [0] },
    ]);
    expect(pagesByDate([p1, p2, p3], 'old').map((d) => d.day)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    // A page from before dates were kept: the day it last changed, if it has anything on it.
    expect(pageDays(page('old', { updated: new Date('2026-09-01T10:00').getTime(), items: [{ id: 't', type: 'text', x: 0, y: 0, w: 1, h: 1, rot: 0, text: 'x', size: 10, color: '#000' }] }))).toEqual(['2026-09-01']);
    expect(pageDays(page('empty'))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { normalize, searchPages } from '../../src/store/search';
import type { Notebook, Page } from '../../src/core/types';

const nb = (id: string, pages: string[]): Notebook => ({
  id, title: id, folder: null, created: 0, updated: 0, opened: 0, pages, cover: '#000',
  paper: { w: 1, h: 1, bg: { tpl: 'blank', spacing: 5, color: '#fff' } },
});
const page = (id: string, nbId: string, extra: Partial<Page>): Page => ({
  id, nb: nbId, w: 1, h: 1, bg: { tpl: 'blank', spacing: 5, color: '#fff' }, strokes: [], items: [], updated: 0, ...extra,
});

describe('search', () => {
  it('normalizes width and case', () => {
    expect(normalize('ＡＢＣ１２３')).toBe('abc123');
    expect(normalize('ｶﾀｶﾅ')).toBe('カタカナ');
  });

  it('finds PDF and typed text, with page index and snippet', () => {
    const a = nb('a', ['p1', 'p2']);
    const pages = [
      page('p1', 'a', { text: '第1問 次の定積分を求めよ。' }),
      page('p2', 'a', { items: [{ id: 't', type: 'text', x: 0, y: 0, w: 1, h: 1, rot: 0, text: 'Integral of x^2', size: 10, color: '#000' }] }),
      page('orphan', 'a', { text: '定積分' }),
    ];
    const map = new Map([['a', a]]);
    const h1 = searchPages(pages, map, '定積分');
    expect(h1.map((h) => [h.page, h.kind])).toEqual([[0, 'pdf']]);
    expect(h1[0].snippet).toContain('定積分');
    const h2 = searchPages(pages, map, 'ＩＮＴＥＧＲＡＬ');
    expect(h2.map((h) => h.page)).toEqual([1]);
  });
});

describe('handwriting', () => {
  it('search finds recognized handwriting', () => {
    const a = nb('a', ['p1']);
    const hits = searchPages([page('p1', 'a', { ink: '微分係数の定義\nf(x+h)-f(x)' })], new Map([['a', a]]), '微分係数');
    expect(hits.map((h) => h.kind)).toEqual(['ink']);
  });
});

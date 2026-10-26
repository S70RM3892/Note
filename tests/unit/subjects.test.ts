import { describe, expect, it } from 'vitest';
import type { Folder, Notebook } from '../../src/core/types';
import { pruneNotebookDays, subjectBreakdown } from '../../src/study/subjects';

const nb = (id: string, title: string, folder: string | null): Notebook => ({
  id, title, folder, created: 0, updated: 0, opened: 0, pages: [], cover: '#123456',
  paper: { w: 1, h: 1, bg: { tpl: 'blank', spacing: 5, color: '#fff' } },
});
const now = new Date(2026, 9, 26, 20).getTime();

describe('教科別の学習時間', () => {
  it('sums the last 7 days by folder, loose notebooks by title', () => {
    const folders: Folder[] = [
      { id: 'm', name: '数学', color: '#1e4fd8', order: 0 },
      { id: 'e', name: '英語', color: '#d32f2f', order: 1 },
    ];
    const nbs = [nb('a', '青チャート', 'm'), nb('b', '京大過去問 数学', 'm'), nb('c', '英作文', 'e'), nb('d', 'メモ', null)];
    const rows = subjectBreakdown(
      {
        a: { '2026-10-26': 1800, '2026-10-20': 600, '2026-10-19': 9999 }, // 10-19 is 8 days ago
        b: { '2026-10-25': 3600 },
        c: { '2026-10-24': 1200 },
        d: { '2026-10-26': 300 },
        gone: { '2026-10-26': 60 },
      },
      nbs,
      folders,
      7,
      now,
    );
    expect(rows.map((r) => [r.name, r.sec])).toEqual([
      ['数学', 6000],
      ['英語', 1200],
      ['メモ', 300],
      ['その他', 60],
    ]);
    expect(rows[0].color).toBe('#1e4fd8');
  });
  it('folds the tail into その他 and prunes old days', () => {
    const byNb = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}`, { '2026-10-26': 100 * (8 - i) }]));
    const rows = subjectBreakdown(byNb, Object.keys(byNb).map((id) => nb(id, id, null)), [], 7, now, 5);
    expect(rows).toHaveLength(6);
    expect(rows[5]).toMatchObject({ name: 'その他', sec: 300 + 200 + 100 });
    expect(pruneNotebookDays({ a: { '2026-08-01': 5, '2026-10-01': 6 }, b: { '2026-07-01': 1 } }, now)).toEqual({ a: { '2026-10-01': 6 } });
  });
});

import { describe, expect, it } from 'vitest';
import type { Folder, Notebook } from '../../src/core/types';
import { examCsv, studyCsv } from '../../src/study/csv';

const nb = (id: string, title: string, folder: string | null): Notebook => ({
  id, title, folder, created: 0, updated: 0, opened: 0, pages: [], cover: '#000',
  paper: { w: 1, h: 1, bg: { tpl: 'blank', spacing: 5, color: '#fff' } },
});

describe('学習記録 CSV', () => {
  it('a day per row: total and per subject, minutes, with a BOM for Excel', () => {
    const folders: Folder[] = [{ id: 'm', name: '数学', color: '#00f', order: 0 }];
    const csv = studyCsv(
      { '2026-10-25': 3600, '2026-10-26': 5400 },
      { a: { '2026-10-26': 3000 }, b: { '2026-10-25': 1200, '2026-10-26': 600 } },
      [nb('a', '青チャート', 'm'), nb('b', '英作文, 毎日', null)],
      folders,
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trim().split('\n');
    expect(lines[0].startsWith('日付,合計(分),')).toBe(true);
    expect(lines[0]).toContain('数学(分)');
    expect(lines[0]).toContain('"英作文, 毎日(分)"');
    const header = lines[0].match(/("[^"]*"|[^,]+)/g)!;
    const r26 = lines[2].split(',');
    expect(r26[0]).toBe('2026-10-26');
    expect(r26[1]).toBe('90');
    expect(r26[header.indexOf('数学(分)')]).toBe('50');
    expect(r26[header.indexOf('"英作文, 毎日(分)"')]).toBe('10');
  });
  it('過去問ログ: oldest first, with the time per 大問', () => {
    const csv = examCsv([
      { at: new Date(2026, 9, 27, 9, 5).getTime(), label: '京大 数学', planned: 9000, used: 7920, laps: [1500, 1860, 1320] },
      { at: new Date(2026, 9, 20, 13, 0).getTime(), label: '京大 英語', planned: 7200, used: 7000 },
    ]);
    const lines = csv.slice(1).trim().split('\n');
    expect(lines[1]).toBe('2026-10-20 13:00,京大 英語,120,117,');
    expect(lines[2]).toBe('2026-10-27 09:05,京大 数学,150,132,25 / 31 / 22');
  });
});

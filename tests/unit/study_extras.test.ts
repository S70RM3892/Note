import { describe, expect, it } from 'vitest';
import { MM } from '../../src/core/geometry';
import { genkouGrid, templateGeometry } from '../../src/core/paper';
import { daysUntil, formatExamDate, upcomingExams } from '../../src/study/countdown';

describe('exam countdown', () => {
  const now = new Date(2026, 9, 26, 23, 30); // 2026-10-26 23:30 local
  it('counts calendar days, not 24h blocks', () => {
    expect(daysUntil('2026-10-27', now)).toBe(1);
    expect(daysUntil('2026-10-26', now)).toBe(0);
    expect(daysUntil('2027-01-16', now)).toBe(82);
    expect(daysUntil('2027-02-25', now)).toBe(122);
    expect(daysUntil('2026-10-25', now)).toBe(-1);
    expect(daysUntil('bad', now)).toBeNaN();
  });
  it('lists upcoming exams soonest first and drops past ones', () => {
    const list = upcomingExams(
      [
        { name: '京大 二次', date: '2027-02-25' },
        { name: '過去', date: '2026-01-01' },
        { name: '共通テスト', date: '2027-01-16' },
        { name: '空', date: '' },
      ],
      now,
    );
    expect(list.map((e) => e.name)).toEqual(['共通テスト', '京大 二次']);
  });
  it('formats with the weekday', () => {
    expect(formatExamDate('2027-01-16')).toBe('1/16(土)');
    expect(formatExamDate('2027-02-25')).toBe('2/25(木)');
  });
});

describe('templates', () => {
  const bg = (tpl: any, spacing = 5) => ({ tpl, spacing, color: '#ffffff' });
  it('原稿用紙: 20×20 squares inside the page with the 柱 in the middle', () => {
    for (const [w, h] of [
      [794, 1123],
      [1123, 794],
    ]) {
      const { cols, cell, y0 } = genkouGrid(w, h);
      expect(cols).toHaveLength(20);
      expect(cols[0]).toBeGreaterThan(0);
      expect(cols[19] + cell).toBeLessThan(w);
      expect(y0).toBeGreaterThan(0);
      expect(y0 + 20 * cell).toBeLessThan(h);
      const gaps = cols.slice(1).map((x, i) => x - cols[i] - cell);
      expect(gaps[9]).toBeGreaterThan(gaps[0] * 3); // 柱
      expect(new Set(gaps.filter((_, i) => i !== 9).map((g) => g.toFixed(3))).size).toBe(1);
    }
    // Landscape A4 gives squares of about 9 mm.
    expect(genkouGrid(1123, 794).cell / MM).toBeGreaterThan(8.5);
    const g = templateGeometry(1123, 794, bg('genkou'));
    expect(g.lines.length / 4).toBe(20 * (2 + 19));
  });
  it('英語4線: groups of four lines, baseline emphasised', () => {
    const g = templateGeometry(794, 1123, bg('english', 4));
    const rows = g.strong.length / 4;
    expect(rows).toBeGreaterThan(10);
    expect(g.lines.length / 4).toBe(rows * 3);
    const sp = 4 * MM;
    // Baseline is two intervals below the top line of its row.
    expect(g.strong[1] - g.lines[1]).toBeCloseTo(2 * sp, 5);
  });
  it('方眼 1cm強調: every other 5 mm line is strong', () => {
    const g = templateGeometry(794, 1123, bg('section', 5));
    const all = g.lines.length + g.strong.length;
    expect(g.strong.length / all).toBeGreaterThan(0.45);
    expect(g.strong.length / all).toBeLessThan(0.55);
  });
});

import { describe, expect, it } from 'vitest';
import { MM } from '../../src/core/geometry';
import { hexEdges, markSheet, templateGeometry } from '../../src/core/paper';

describe('六角方眼', () => {
  it('a honeycomb of equal edges at 120°, each edge once, covering the page', () => {
    const side = 6 * MM;
    const e = hexEdges(794, 1123, side);
    const n = e.length / 4;
    expect(n).toBeGreaterThan(1500);
    const keys = new Set<string>();
    for (let i = 0; i < e.length; i += 4) {
      const len = Math.hypot(e[i + 2] - e[i], e[i + 3] - e[i + 1]);
      expect(len).toBeCloseTo(side, 3);
      // Directions: vertical, or ±30° from horizontal (bonds of a zig-zag chain).
      const a = (Math.atan2(e[i + 3] - e[i + 1], e[i + 2] - e[i]) * 180) / Math.PI;
      const m = ((a % 180) + 180) % 180;
      expect([30, 90, 150].some((t) => Math.abs(m - t) < 1e-6)).toBe(true);
      const k = [e[i], e[i + 1], e[i + 2], e[i + 3]].map((v) => Math.round(v * 10)).join(',');
      expect(keys.has(k)).toBe(false);
      keys.add(k);
    }
    const xs = e.filter((_, i) => i % 2 === 0), ys = e.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeLessThanOrEqual(0);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(794);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(1123);
  });
});

describe('マークシート', () => {
  it('numbered rows of ten bubbles (1–9, 0) inside the page', () => {
    const m = markSheet(794, 1123, 5 * MM);
    expect(m.rows).toBeGreaterThan(60);
    expect(m.rings.length / 4).toBe(m.rows * 10);
    for (let i = 0; i < m.rings.length; i += 4) {
      expect(m.rings[i] - m.rings[i + 2]).toBeGreaterThan(0);
      expect(m.rings[i] + m.rings[i + 2]).toBeLessThan(794);
      expect(m.rings[i + 1] + m.rings[i + 3]).toBeLessThan(1123);
      expect(m.rings[i + 3]).toBeGreaterThan(m.rings[i + 2]); // vertical ovals
    }
    const numbers = m.labels.filter((l) => !l.faint && /^\d+$/.test(l.text) && l.size > 5 * MM * 0.5).map((l) => Number(l.text));
    expect(numbers.slice(0, 3)).toEqual([1, 2, 3]);
    expect(Math.max(...numbers)).toBe(m.rows);
    const g = templateGeometry(794, 1123, { tpl: 'marksheet', spacing: 5, color: '#ffffff' });
    expect(g.rings.length).toBe(m.rings.length);
  });
});

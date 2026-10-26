import { describe, expect, it } from 'vitest';
import { circlesOf, radiusFor, strokeOutline, strokeSvgPath } from '../../src/core/ink';
import { mkStroke, windingContains } from './helpers';

function bbox(poly: number[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

describe('ink geometry', () => {
  it('nominal width at pressure 0.5', () => {
    expect(radiusFor('pen', 'ballpoint', 4, 0.5)).toBeCloseTo(2);
    expect(radiusFor('pen', 'fountain', 4, 0.5)).toBeCloseTo(2);
    expect(radiusFor('highlighter', 'fountain', 10, 0.1)).toBeCloseTo(5);
    expect(radiusFor('pen', 'fountain', 4, 1)).toBeGreaterThan(radiusFor('pen', 'fountain', 4, 0.2));
  });

  it('outline of a straight constant stroke is a capsule', () => {
    const pts: [number, number][] = [];
    for (let x = 0; x <= 100; x += 5) pts.push([x, 0]);
    const s = mkStroke(pts);
    const o = strokeOutline(s);
    const b = bbox(o);
    expect(Math.abs(b.minX + 2)).toBeLessThan(0.1);
    expect(Math.abs(b.maxX - 102)).toBeLessThan(0.1);
    expect(Math.abs(b.minY + 2)).toBeLessThan(0.1);
    expect(Math.abs(b.maxY - 2)).toBeLessThan(0.1);
    for (let x = 0; x <= 100; x += 1) expect(windingContains(o, x, 0)).toBe(true);
    expect(windingContains(o, 50, 3)).toBe(false);
  });

  it('outline covers every sample of a curvy pressure stroke', () => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 200; i++) {
      const t = i / 20;
      pts.push([t * 30 + Math.sin(t * 3) * 25, Math.cos(t * 2.3) * 40, 0.2 + 0.7 * Math.abs(Math.sin(t))]);
    }
    const s = mkStroke(pts, { style: 'fountain', width: 6 });
    const o = strokeOutline(s);
    for (const [x, y] of pts) expect(windingContains(o, x, y)).toBe(true);
  });

  it('handles a sharp U-turn and repeated points', () => {
    const s = mkStroke([[0, 0], [50, 0], [50, 0], [0, 1], [0, 1]]);
    const o = strokeOutline(s);
    expect(o.length).toBeGreaterThan(8);
    expect(windingContains(o, 25, 0.5)).toBe(true);
  });

  it('single point becomes a dot', () => {
    const s = mkStroke([[10, 10, 0.5]]);
    const o = strokeOutline(s);
    const b = bbox(o);
    expect(b.maxX - b.minX).toBeCloseTo(4, 0);
    expect(strokeSvgPath(s).startsWith('M')).toBe(true);
  });

  it('drops samples swallowed by neighbours', () => {
    const s = mkStroke([[0, 0, 1], [0.1, 0, 0.1], [10, 0, 0.5]]);
    expect(circlesOf(s).length).toBe(2);
  });
});

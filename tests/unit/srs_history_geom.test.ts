import { describe, expect, it } from 'vitest';
import { addDays, grade, isDue, newReview, startOfDay } from '../../src/core/srs';
import { History } from '../../src/core/history';
import { applyMat, capsuleHitsStroke, itemContains, pointInPolygon, similarity, transformItem, transformStroke } from '../../src/core/geometry';
import { mkStroke } from './helpers';
import type { TapeItem } from '../../src/core/types';

describe('srs', () => {
  const now = new Date(2026, 9, 26, 21, 0).getTime();
  it('schedules growing intervals', () => {
    let r = newReview(now);
    expect(r.due).toBe(addDays(now, 1));
    expect(isDue(r, now)).toBe(false);
    expect(isDue(r, addDays(now, 1) + 1)).toBe(true);
    r = grade(r, 3, now);
    expect(r.interval).toBe(1);
    r = grade(r, 3, now);
    expect(r.interval).toBe(3);
    r = grade(r, 3, now);
    expect(r.interval).toBeGreaterThanOrEqual(7);
    const lapsed = grade(r, 1, now);
    expect(lapsed.interval).toBe(1);
    expect(lapsed.reps).toBe(0);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.ease).toBeLessThan(r.ease);
    expect(startOfDay(lapsed.due)).toBe(lapsed.due);
  });
});

describe('history', () => {
  it('undo/redo', () => {
    const h = new History(3);
    let v = 0;
    const set = (a: number, b: number) => ({ undo: () => (v = a), redo: () => (v = b) });
    v = 1; h.push(set(0, 1));
    v = 2; h.push(set(1, 2));
    expect(h.undo()).toBe(true);
    expect(v).toBe(1);
    expect(h.redo()).toBe(true);
    expect(v).toBe(2);
    h.undo();
    v = 5; h.push(set(1, 5));
    expect(h.canRedo).toBe(false);
  });
});

describe('geometry', () => {
  it('similarity transform rotates around pivot', () => {
    const m = similarity(10, 10, 2, Math.PI / 2);
    const p = applyMat(m, 20, 10);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(30);
  });

  it('transforms strokes and items', () => {
    const s = transformStroke(mkStroke([[0, 0], [10, 0]]), similarity(0, 0, 2, 0, 5, 5));
    expect(s.width).toBeCloseTo(8);
    expect(s.pts[3]).toBeCloseTo(25);
    const t: TapeItem = { id: 't', type: 'tape', x: 0, y: 0, w: 100, h: 20, rot: 0, color: '#f00' };
    const t2 = transformItem(t, similarity(50, 10, 1, Math.PI / 2));
    expect(t2.x + t2.w / 2).toBeCloseTo(50);
    expect(itemContains(t2, 50, 50)).toBe(true);
    expect(itemContains(t2, 90, 10)).toBe(false);
  });

  it('hit tests', () => {
    const s = mkStroke([[0, 0], [100, 0]]);
    expect(capsuleHitsStroke(s, 50, 10, 50, 5, 4)).toBe(true);
    expect(capsuleHitsStroke(s, 50, 20, 60, 20, 4)).toBe(false);
    expect(capsuleHitsStroke(s, 50, -20, 50, 20, 1)).toBe(true);
    expect(pointInPolygon(5, 5, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
  });
});

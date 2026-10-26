import { describe, expect, it } from 'vitest';
import { eraseStroke } from '../../src/core/eraser';
import { mkStroke } from './helpers';

describe('partial eraser', () => {
  const line = () => mkStroke(Array.from({ length: 21 }, (_, i) => [i * 10, 0] as [number, number]));

  it('untouched stroke returns null', () => {
    expect(eraseStroke(line(), 100, 50, 110, 50, 5)).toBeNull();
  });

  it('splits a line in two', () => {
    const parts = eraseStroke(line(), 100, -20, 100, 20, 5)!;
    expect(parts.length).toBe(2);
    const maxX0 = Math.max(...Array.from(parts[0].pts).filter((_, i) => i % 3 === 0));
    const minX1 = Math.min(...Array.from(parts[1].pts).filter((_, i) => i % 3 === 0));
    expect(maxX0).toBeLessThan(100);
    expect(minX1).toBeGreaterThan(100);
  });

  it('erases fully', () => {
    expect(eraseStroke(mkStroke([[0, 0], [3, 0]]), 1, 0, 2, 0, 10)).toEqual([]);
  });

  it('closed shape cut once stays one piece', () => {
    const sq = mkStroke([[0, 0], [100, 0], [100, 100], [0, 100]], { shape: true, closed: true });
    const parts = eraseStroke(sq, 50, 100, 50, 100, 5)!;
    expect(parts.length).toBe(1);
    expect(parts[0].closed).toBe(false);
  });
});

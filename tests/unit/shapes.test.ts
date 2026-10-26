import { describe, expect, it } from 'vitest';
import { recognizeShape } from '../../src/core/shapes';
import type { Pt } from '../../src/core/types';

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
}

function noisy(pts: Pt[], amp: number, seed = 7): Pt[] {
  const r = rng(seed);
  return pts.map((p) => ({ x: p.x + r() * amp, y: p.y + r() * amp }));
}

function polyPath(verts: Pt[], perEdge = 25, close = true): Pt[] {
  const out: Pt[] = [];
  const n = close ? verts.length : verts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    for (let k = 0; k < perEdge; k++) out.push({ x: a.x + ((b.x - a.x) * k) / perEdge, y: a.y + ((b.y - a.y) * k) / perEdge });
  }
  out.push(close ? verts[0] : verts[verts.length - 1]);
  return out;
}

describe('shape recognition', () => {
  it('line (snapped horizontal)', () => {
    const pts = noisy(Array.from({ length: 50 }, (_, i) => ({ x: i * 4, y: 100 + i * 0.05 })), 1.5);
    const s = recognizeShape(pts)!;
    expect(s.kind).toBe('line');
    expect(s.pts[1].y).toBeCloseTo(s.pts[0].y, 3);
  });

  it('circle', () => {
    const pts = noisy(Array.from({ length: 80 }, (_, i) => {
      const t = (i / 79) * Math.PI * 2 * 1.02;
      return { x: 200 + 60 * Math.cos(t), y: 200 + 60 * Math.sin(t) };
    }), 4);
    expect(recognizeShape(pts)!.kind).toBe('circle');
  });

  it('ellipse', () => {
    const pts = noisy(Array.from({ length: 80 }, (_, i) => {
      const t = (i / 79) * Math.PI * 2;
      return { x: 200 + 100 * Math.cos(t), y: 200 + 40 * Math.sin(t) };
    }), 3);
    expect(recognizeShape(pts)!.kind).toBe('ellipse');
  });

  it('rectangle', () => {
    const pts = noisy(polyPath([{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 90 }, { x: 0, y: 90 }]), 3);
    const s = recognizeShape(pts)!;
    expect(s.kind).toBe('rectangle');
    expect(s.pts.length).toBe(4);
    expect(s.pts[0].y).toBeCloseTo(s.pts[1].y, 3);
  });

  it('triangle', () => {
    const pts = noisy(polyPath([{ x: 0, y: 100 }, { x: 60, y: 0 }, { x: 120, y: 100 }]), 2.5);
    expect(recognizeShape(pts)!.kind).toBe('triangle');
  });

  it('open angle becomes a polyline', () => {
    const pts = noisy(polyPath([{ x: 0, y: 0 }, { x: 0, y: 120 }, { x: 150, y: 120 }], 30, false), 2);
    const s = recognizeShape(pts)!;
    expect(s.kind).toBe('polyline');
    expect(s.pts.length).toBe(3);
  });

  it('handwriting is left alone', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 10;
      pts.push({ x: t * 12 + Math.sin(t * 5) * 9, y: Math.cos(t * 7) * 14 + Math.sin(t * 2) * 8 });
    }
    expect(recognizeShape(pts)).toBeNull();
  });
});

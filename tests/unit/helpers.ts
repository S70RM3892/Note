import type { Stroke } from '../../src/core/types';

export function mkStroke(points: [number, number, number?][], extra: Partial<Stroke> = {}): Stroke {
  const pts = new Float32Array(points.length * 3);
  points.forEach(([x, y, p], i) => {
    pts[i * 3] = x;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = p ?? 0.5;
  });
  return { id: 's' + Math.random(), kind: 'pen', style: 'ballpoint', color: '#000000', width: 4, pts, ...extra };
}

/** Nonzero winding number test for a flat x,y polygon. */
export function windingContains(poly: number[], x: number, y: number): boolean {
  let wn = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = poly[i * 2], y1 = poly[i * 2 + 1];
    const j = (i + 1) % n;
    const x2 = poly[j * 2], y2 = poly[j * 2 + 1];
    const isLeft = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
    if (y1 <= y) {
      if (y2 > y && isLeft > 0) wn++;
    } else if (y2 <= y && isLeft < 0) wn--;
  }
  return wn !== 0;
}

import { distToSegment, strokeBounds } from './geometry';
import { uid } from './id';
import { strokeRadius } from './ink';
import type { Stroke } from './types';

/** Insert samples so consecutive points are at most `maxGap` apart. */
export function densify(s: Stroke, maxGap: number): Float32Array {
  const p = s.pts;
  const closed = !!s.closed && p.length >= 9;
  const out: number[] = [];
  const n = p.length / 3;
  const segs = closed ? n : n - 1;
  if (n === 1) return p;
  for (let k = 0; k < segs; k++) {
    const i = k * 3, j = ((k + 1) % n) * 3;
    const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / maxGap));
    for (let t = 0; t < steps; t++) {
      const f = t / steps;
      out.push(p[i] + dx * f, p[i + 1] + dy * f, p[i + 2] + (p[j + 2] - p[i + 2]) * f);
    }
  }
  if (closed) out.push(p[0], p[1], p[2]);
  else out.push(p[p.length - 3], p[p.length - 2], p[p.length - 1]);
  return new Float32Array(out);
}

/**
 * Partially erase a stroke with the capsule A→B of radius r.
 * Returns null when the stroke is untouched, otherwise the surviving pieces (maybe none).
 */
export function eraseStroke(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): Stroke[] | null {
  const b = strokeBounds(s);
  const reachMax = r + s.width;
  if (Math.max(ax, bx) + reachMax < b.x || Math.min(ax, bx) - reachMax > b.x + b.w) return null;
  if (Math.max(ay, by) + reachMax < b.y || Math.min(ay, by) - reachMax > b.y + b.h) return null;

  const pts = densify(s, Math.max(0.6, r / 3));
  const n = pts.length / 3;
  const erased = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const i = k * 3;
    const reach = r + strokeRadius(s, pts[i + 2]) * 0.5;
    if (distToSegment(pts[i], pts[i + 1], ax, ay, bx, by) <= reach) {
      erased[k] = 1;
      any = true;
    }
  }
  if (!any) return null;

  const runs: [number, number][] = [];
  let start = -1;
  for (let k = 0; k <= n; k++) {
    if (k < n && !erased[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      runs.push([start, k]);
      start = -1;
    }
  }
  const pieces: Float32Array[] = runs.map(([a, e]) => pts.slice(a * 3, e * 3));
  // A closed shape whose first and last points survive wraps around: join those runs.
  if (s.closed && runs.length >= 2 && runs[0][0] === 0 && runs[runs.length - 1][1] === n) {
    const last = pieces.pop()!;
    const first = pieces.shift()!;
    const joined = new Float32Array(last.length + first.length - 3);
    joined.set(last);
    joined.set(first.subarray(3), last.length);
    pieces.unshift(joined);
  }
  return pieces
    .filter((q) => q.length >= 6)
    .map((q) => ({ ...s, id: uid(), pts: q, closed: false }));
}

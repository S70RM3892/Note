import type { Pt } from './types';

export type ShapeKind = 'line' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse' | 'circle' | 'polyline';

export interface RecognizedShape {
  kind: ShapeKind;
  pts: Pt[];
  closed: boolean;
}

const DEG = Math.PI / 180;

function pathLength(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / L;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Ramer–Douglas–Peucker. Returns indices of kept points. */
export function rdp(p: Pt[], eps: number): number[] {
  if (p.length < 3) return p.map((_, i) => i);
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(p[i], p[s], p[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

/** Snap a direction to multiples of 45° when within tol. */
function snapAngle(a: number, tol: number): number {
  const step = 45 * DEG;
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) < tol ? s : a;
}

function fitLine(p: Pt[]): RecognizedShape {
  const a = p[0], b = p[p.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ang = snapAngle(Math.atan2(b.y - a.y, b.x - a.x), 5 * DEG);
  return { kind: 'line', closed: false, pts: [a, { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }] };
}

function polygonError(p: Pt[], verts: Pt[], closed: boolean): number {
  let sum = 0;
  const n = verts.length;
  for (const q of p) {
    let best = Infinity;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) best = Math.min(best, segDist(q, verts[i], verts[(i + 1) % n]));
    sum += best;
  }
  return sum / p.length;
}

interface EllipseFit {
  cx: number;
  cy: number;
  a: number;
  b: number;
  ang: number;
  err: number; // mean |r - 1|
}

function fitEllipse(p: Pt[]): EllipseFit {
  // Resample by arc length so slow parts of the stroke don't dominate.
  const q = resample(p, 64);
  let cx = 0, cy = 0;
  for (const v of q) {
    cx += v.x;
    cy += v.y;
  }
  cx /= q.length;
  cy /= q.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const v of q) {
    const dx = v.x - cx, dy = v.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= q.length;
  syy /= q.length;
  sxy /= q.length;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
  let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let a = Math.sqrt(2 * l1), b = Math.sqrt(2 * l2);
  let err = 0;
  const c = Math.cos(-ang), s = Math.sin(-ang);
  for (const v of q) {
    const dx = v.x - cx, dy = v.y - cy;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    err += Math.abs(Math.sqrt((lx / a) ** 2 + (ly / b) ** 2) - 1);
  }
  err /= q.length;
  if (Math.abs(ang) < 10 * DEG || Math.abs(Math.abs(ang) - Math.PI / 2) < 10 * DEG) {
    // Snap to axis-aligned.
    if (Math.abs(Math.abs(ang) - Math.PI / 2) < 10 * DEG) [a, b] = [b, a];
    ang = 0;
  }
  return { cx, cy, a, b, ang, err };
}

export function resample(p: Pt[], n: number): Pt[] {
  const L = pathLength(p);
  if (L === 0 || p.length < 2) return p.slice();
  const step = L / (n - 1);
  const out: Pt[] = [p[0]];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    let a = p[i - 1];
    const b = p[i];
    let seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (acc + seg >= step && out.length < n) {
      const t = (step - acc) / seg;
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(q);
      seg -= step - acc;
      a = q;
      acc = 0;
    }
    acc += seg;
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out;
}

function ellipsePoints(e: EllipseFit, circle: boolean): Pt[] {
  const a = circle ? (e.a + e.b) / 2 : e.a;
  const b = circle ? a : e.b;
  const n = Math.max(48, Math.min(160, Math.round((a + b) * 0.8)));
  const c = Math.cos(e.ang), s = Math.sin(e.ang);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    out.push({ x: e.cx + x * c - y * s, y: e.cy + x * s + y * c });
  }
  return out;
}

function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  return d ? Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) : 0;
}

function squareUp(v: Pt[]): Pt[] {
  // Fit a rectangle to four corners: use the average edge direction.
  let ang = 0, wsum = 0;
  for (let i = 0; i < 4; i++) {
    const a = v[i], b = v[(i + 1) % 4];
    let t = Math.atan2(b.y - a.y, b.x - a.x);
    // Fold into [-45°, 45°)
    t = ((((t + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    ang += t * w;
    wsum += w;
  }
  ang = wsum ? ang / wsum : 0;
  if (Math.abs(ang) < 6 * DEG) ang = 0;
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const loc = v.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  const xs = loc.map((p) => p.x).sort((a, b) => a - b);
  const ys = loc.map((p) => p.y).sort((a, b) => a - b);
  const x0 = (xs[0] + xs[1]) / 2, x1 = (xs[2] + xs[3]) / 2;
  const y0 = (ys[0] + ys[1]) / 2, y1 = (ys[2] + ys[3]) / 2;
  const cb = Math.cos(ang), sb = Math.sin(ang);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ].map((p) => ({ x: p.x * cb - p.y * sb, y: p.x * sb + p.y * cb }));
}

/**
 * Recognize a hand-drawn shape. Returns null when nothing fits well enough
 * (the stroke is then kept as drawn).
 */
export function recognizeShape(raw: Pt[]): RecognizedShape | null {
  if (raw.length < 2) return null;
  const L = pathLength(raw);
  if (L < 12) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of raw) {
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const a = raw[0], b = raw[raw.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);

  // Straight line.
  let maxDev = 0;
  for (const q of raw) maxDev = Math.max(maxDev, perpDist(q, a, b));
  if (chord > 0.85 * L && maxDev < Math.max(2.5, 0.07 * chord)) return fitLine(raw);

  const closed = chord < Math.max(0.22 * diag, 8);
  const eps = Math.max(2, 0.07 * diag);

  if (closed) {
    // Close the loop and simplify.
    const loop = raw.concat([raw[0]]);
    const idx = rdp(loop, eps);
    let verts = idx.map((i) => loop[i]);
    verts.pop(); // last == first
    // Merge vertices that are too close together.
    verts = verts.filter((v, i) => {
      const n = verts[(i + 1) % verts.length];
      return Math.hypot(n.x - v.x, n.y - v.y) > 0.12 * diag;
    });
    // Drop near-straight vertices.
    verts = verts.filter((v, i) => {
      const pv = verts[(i - 1 + verts.length) % verts.length];
      const nv = verts[(i + 1) % verts.length];
      return angleAt(pv, v, nv) < 160 * DEG;
    });
    const ell = fitEllipse(raw);
    const polyErr = verts.length >= 3 ? polygonError(raw, verts, true) / diag : Infinity;
    const ellErr = (ell.err * (ell.a + ell.b)) / 2 / diag;
    if (verts.length >= 3 && verts.length <= 5 && polyErr < 0.045 && polyErr <= ellErr * 1.15) {
      if (verts.length === 3) return { kind: 'triangle', closed: true, pts: verts };
      if (verts.length === 4) {
        const angs = verts.map((v, i) => angleAt(verts[(i + 3) % 4], v, verts[(i + 1) % 4]));
        if (angs.every((t) => Math.abs(t - Math.PI / 2) < 20 * DEG)) return { kind: 'rectangle', closed: true, pts: squareUp(verts) };
      }
      return { kind: 'polygon', closed: true, pts: verts };
    }
    if (ell.err < 0.13) {
      const circle = ell.b / ell.a > 0.84;
      return { kind: circle ? 'circle' : 'ellipse', closed: true, pts: ellipsePoints(ell, circle) };
    }
    return null;
  }

  // Open polyline (e.g. an angle bracket or a coordinate axis corner).
  const idx = rdp(raw, eps);
  const verts = idx.map((i) => raw[i]);
  if (verts.length >= 3 && verts.length <= 4 && polygonError(raw, verts, false) / diag < 0.03) {
    return { kind: 'polyline', closed: false, pts: verts };
  }
  return null;
}

import type { Item, Pt, Rect, Stroke } from './types';

export const MM = 96 / 25.4; // page units per millimetre

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

const boundsCache = new WeakMap<Stroke, Rect>();

/** Bounds of a stroke including its ink width. */
export function strokeBounds(s: Stroke): Rect {
  let b = boundsCache.get(s);
  if (b) return b;
  const p = s.pts;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) minX = minY = maxX = maxY = 0;
  const pad = s.width * (s.shape ? 0.5 : 0.75) + 1;
  b = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  boundsCache.set(s, b);
  return b;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function segIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between segments AB and CD. */
export function segToSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distToSegment(ax, ay, cx, cy, dx, dy),
    distToSegment(bx, by, cx, cy, dx, dy),
    distToSegment(cx, cy, ax, ay, bx, by),
    distToSegment(dx, dy, ax, ay, bx, by),
  );
}

/** Even-odd point in polygon. poly is a list of points. */
export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does the capsule (segment AB with radius r) touch the stroke? */
export function capsuleHitsStroke(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const reach = r + s.width / 2;
  const b = strokeBounds(s);
  if (Math.max(ax, bx) + reach < b.x || Math.min(ax, bx) - reach > b.x + b.w) return false;
  if (Math.max(ay, by) + reach < b.y || Math.min(ay, by) - reach > b.y + b.h) return false;
  const p = s.pts;
  if (p.length === 3) return distToSegment(p[0], p[1], ax, ay, bx, by) <= reach;
  const n = s.closed ? p.length : p.length - 3;
  for (let i = 0; i < n; i += 3) {
    const j = (i + 3) % p.length;
    if (segToSegDist(p[i], p[i + 1], p[j], p[j + 1], ax, ay, bx, by) <= reach) return true;
  }
  return false;
}

// ---------- Affine transforms ----------

/** [a, b, c, d, e, f] maps (x, y) -> (a*x + c*y + e, b*x + d*y + f) */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function matMul(m: Mat, n: Mat): Mat {
  // m * n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate(tx: number, ty: number): Mat {
  return [1, 0, 0, 1, tx, ty];
}

/** Uniform scale + rotation around pivot, then translation. */
export function similarity(px: number, py: number, scale: number, angle: number, tx = 0, ty = 0): Mat {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return [c, s, -s, c, px - c * px + s * py + tx, py - s * px - c * py + ty];
}

export function applyMat(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function matAngle(m: Mat): number {
  return Math.atan2(m[1], m[0]);
}

export function transformStroke(s: Stroke, m: Mat, newId?: string): Stroke {
  const src = s.pts;
  const pts = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1];
    pts[i] = m[0] * x + m[2] * y + m[4];
    pts[i + 1] = m[1] * x + m[3] * y + m[5];
    pts[i + 2] = src[i + 2];
  }
  return { ...s, id: newId ?? s.id, pts, width: s.width * matScale(m) };
}

export function itemCenter(it: Item): Pt {
  return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
}

export function transformItem<T extends Item>(it: T, m: Mat, newId?: string): T {
  const k = matScale(m);
  const c = applyMat(m, it.x + it.w / 2, it.y + it.h / 2);
  const w = it.w * k, h = it.h * k;
  const out = { ...it, id: newId ?? it.id, x: c.x - w / 2, y: c.y - h / 2, w, h, rot: it.rot + matAngle(m) };
  if (out.type === 'text') out.size = out.size * k;
  return out;
}

/** Corners of an item (rotation applied), clockwise from top-left. */
export function itemCorners(it: Item): Pt[] {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  const hw = it.w / 2, hh = it.h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

export function itemBounds(it: Item): Rect {
  if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h };
  const cs = itemCorners(it);
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function itemContains(it: Item, x: number, y: number, pad = 0): boolean {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const c = Math.cos(-it.rot), s = Math.sin(-it.rot);
  const lx = (x - cx) * c - (y - cy) * s, ly = (x - cx) * s + (y - cy) * c;
  return Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.h / 2 + pad;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

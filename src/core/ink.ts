import type { PenStyle, Stroke } from './types';

/**
 * Variable-width ink geometry.
 *
 * A stroke is the union of circles (one per sample, radius from pressure) joined by
 * their exact outer tangent lines. Live drawing paints that union segment by segment
 * (so it can be drawn incrementally on a low-latency canvas), and the committed stroke
 * is filled from a single outline polygon of the same union, so nothing jumps when the
 * pen lifts.
 */

const MIN_RATIO: Record<PenStyle, number> = {
  ballpoint: 0.5,
  fountain: 0.18,
  marker: 1,
  pencil: 0.45,
};

/** Radius for a sample. Pressure 0.5 gives the nominal width. */
export function radiusFor(kind: Stroke['kind'], style: PenStyle, width: number, p: number): number {
  const min = kind === 'highlighter' ? 1 : MIN_RATIO[style];
  const f = min + (1 - min) * 2 * Math.min(1, Math.max(0, p));
  return Math.max(0.25, (width / 2) * f);
}

export function strokeRadius(s: Stroke, p: number): number {
  return radiusFor(s.kind, s.style, s.width, p);
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Drop samples that are swallowed by a neighbouring circle (no outer tangent exists). */
export function circlesOf(s: Stroke): Circle[] {
  const p = s.pts;
  const out: Circle[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const c = { x: p[i], y: p[i + 1], r: strokeRadius(s, p[i + 2]) };
    let last = out[out.length - 1];
    while (last) {
      const d = Math.hypot(c.x - last.x, c.y - last.y);
      if (d + c.r <= last.r + 1e-3) break; // new circle inside previous: skip it
      if (d + last.r <= c.r + 1e-3) {
        out.pop(); // previous inside new: drop previous
        last = out[out.length - 1];
        continue;
      }
      break;
    }
    if (last) {
      const d = Math.hypot(c.x - last.x, c.y - last.y);
      if (d + c.r <= last.r + 1e-3) continue;
      if (d < 0.05) continue;
    }
    out.push(c);
  }
  return out;
}

interface Tangents {
  l1x: number; l1y: number; l2x: number; l2y: number;
  r1x: number; r1y: number; r2x: number; r2y: number;
  ua: number; // direction angle
  alpha: number; // half-angle of the tangent points around the direction
}

function tangents(a: Circle, b: Circle): Tangents {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d;
  const nx = -uy, ny = ux;
  const cos = Math.max(-1, Math.min(1, (a.r - b.r) / d));
  const sin = Math.sqrt(1 - cos * cos);
  const lx = ux * cos + nx * sin, ly = uy * cos + ny * sin;
  const rx = ux * cos - nx * sin, ry = uy * cos - ny * sin;
  return {
    l1x: a.x + a.r * lx, l1y: a.y + a.r * ly,
    l2x: b.x + b.r * lx, l2y: b.y + b.r * ly,
    r1x: a.x + a.r * rx, r1y: a.y + a.r * ry,
    r2x: b.x + b.r * rx, r2y: b.y + b.r * ry,
    ua: Math.atan2(uy, ux),
    alpha: Math.acos(cos),
  };
}

function arcStep(r: number): number {
  return Math.min(0.45, Math.max(0.1, 1.2 / Math.sqrt(Math.max(r, 0.5) * 4)));
}

/** Append arc points from angle a0 to a1 (signed sweep), excluding the start point. */
function pushArc(out: number[], c: Circle, a0: number, sweep: number) {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep(c.r)));
  for (let k = 1; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push(c.x + c.r * Math.cos(a), c.y + c.r * Math.sin(a));
  }
}

function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Join two tangent points around a circle along the short way, adding arc points on sharp turns. */
function pushJoin(out: number[], c: Circle, fx: number, fy: number, tx: number, ty: number) {
  const a0 = Math.atan2(fy - c.y, fx - c.x);
  const a1 = Math.atan2(ty - c.y, tx - c.x);
  const sweep = normAngle(a1 - a0);
  if (Math.abs(sweep) > 0.3) pushArc(out, c, a0, sweep);
  else out.push(tx, ty);
}

/** Closed outline polygon (flat x,y list) of a pressure stroke. */
export function strokeOutline(s: Stroke): number[] {
  const cs = circlesOf(s);
  const out: number[] = [];
  if (cs.length === 0) return out;
  if (cs.length === 1) {
    const c = cs[0];
    out.push(c.x + c.r, c.y);
    pushArc(out, c, 0, Math.PI * 2 - 1e-6);
    return out;
  }
  const ts: Tangents[] = [];
  for (let i = 0; i < cs.length - 1; i++) ts.push(tangents(cs[i], cs[i + 1]));

  // Left side, forward.
  out.push(ts[0].l1x, ts[0].l1y);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    out.push(t.l2x, t.l2y);
    if (i + 1 < ts.length) pushJoin(out, cs[i + 1], t.l2x, t.l2y, ts[i + 1].l1x, ts[i + 1].l1y);
  }
  // End cap: from the left tangent point to the right one through the forward direction.
  const te = ts[ts.length - 1];
  pushArc(out, cs[cs.length - 1], te.ua + te.alpha, -2 * te.alpha);
  // Right side, backward.
  for (let i = ts.length - 1; i >= 0; i--) {
    const t = ts[i];
    out.push(t.r1x, t.r1y);
    if (i > 0) pushJoin(out, cs[i], t.r1x, t.r1y, ts[i - 1].r2x, ts[i - 1].r2y);
  }
  // Start cap: through the backward direction.
  const t0 = ts[0];
  pushArc(out, cs[0], t0.ua - t0.alpha, -(2 * Math.PI - 2 * t0.alpha));
  return out;
}

/** Polyline points (flat x,y) of a shape stroke. */
export function shapePolyline(s: Stroke): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.pts.length; i += 3) out.push(s.pts[i], s.pts[i + 1]);
  return out;
}

const pathCache = new WeakMap<Stroke, Path2D>();

export function strokePath(s: Stroke): Path2D {
  let p = pathCache.get(s);
  if (p) return p;
  p = new Path2D();
  const pts = s.shape ? shapePolyline(s) : strokeOutline(s);
  if (pts.length >= 2) {
    p.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
    if (!s.shape || s.closed) p.closePath();
  }
  pathCache.set(s, p);
  return p;
}

export function strokeSvgPath(s: Stroke): string {
  const pts = s.shape ? shapePolyline(s) : strokeOutline(s);
  if (pts.length < 2) return '';
  const parts: string[] = [`M${pts[0].toFixed(2)} ${pts[1].toFixed(2)}`];
  for (let i = 2; i < pts.length; i += 2) parts.push(`L${pts[i].toFixed(2)} ${pts[i + 1].toFixed(2)}`);
  if (!s.shape || s.closed) parts.push('Z');
  return parts.join('');
}

export const HIGHLIGHT_ALPHA = 0.45;

export function isDarkColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

// ---------- pencil grain ----------

const grainTiles = new Map<string, HTMLCanvasElement>();
const TILE = 96;

function mix(hex: string, target: number, t: number): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return c.map((v) => Math.round(v + (target - v) * t)) as [number, number, number];
}

/** Opaque speckled tile: graphite colour with paper-coloured grains (seeded, so stable). */
function grainTile(color: string, dark: boolean): HTMLCanvasElement {
  const key = color + (dark ? 'd' : 'l');
  let c = grainTiles.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = TILE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(TILE, TILE);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < TILE * TILE; i++) {
    // Mostly solid, with sparse light grains and a faint horizontal fibre.
    const r = rnd();
    const fibre = (Math.floor(i / TILE) % 7 === 0 ? 0.08 : 0) * rnd();
    const t = r > 0.82 ? 0.35 + 0.45 * rnd() : r * 0.12 + fibre;
    const [R, G, B] = mix(color, dark ? 0 : 255, t);
    img.data[i * 4] = R;
    img.data[i * 4 + 1] = G;
    img.data[i * 4 + 2] = B;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainTiles.set(key, c);
  return c;
}

/**
 * Pencil fill: one texel per device pixel, anchored at the page origin, so the live
 * stroke and the committed one show exactly the same grain.
 * `originX/Y` = page origin in this context's device pixels when the context itself
 * is not in page coordinates (live layer).
 */
export function pencilFill(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, color: string, dark: boolean, originX?: number, originY?: number): CanvasPattern | string {
  if (typeof document === 'undefined') return color;
  const pat = ctx.createPattern(grainTile(color, dark), 'repeat');
  if (!pat) return color;
  if (originX !== undefined && originY !== undefined) pat.setTransform(new DOMMatrix([1, 0, 0, 1, originX, originY]));
  else {
    const m = ctx.getTransform();
    const k = Math.hypot(m.a, m.b) || 1;
    pat.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
  }
  return pat;
}

/**
 * Paint a stroke in page coordinates (the caller sets the transform).
 * Highlighters multiply onto light paper (ink stays dark, as with a real marker,
 * and a green marker turns black under the red sheet).
 */
export function paintStroke(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: Stroke, darkPaper: boolean) {
  const path = strokePath(s);
  ctx.save();
  if (s.kind === 'highlighter') {
    if (darkPaper) ctx.globalAlpha = HIGHLIGHT_ALPHA;
    else ctx.globalCompositeOperation = 'multiply';
  }
  const fill = s.kind === 'pen' && s.style === 'pencil' ? pencilFill(ctx, s.color, darkPaper) : s.color;
  if (s.shape) {
    ctx.strokeStyle = fill;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else {
    ctx.fillStyle = fill;
    ctx.fill(path, 'nonzero');
  }
  ctx.restore();
}

/**
 * Incremental painter for the live stroke. Coordinates passed in are already in
 * canvas pixels; it paints the newest tangent quad plus the newest circle, which is
 * exactly the part of the union the committed outline adds.
 */
export class LiveInkPainter {
  private last: Circle | null = null;
  /** Optional fill (pencil grain); defaults to the plain colour. */
  fill: string | CanvasPattern | null = null;

  constructor(private ctx: CanvasRenderingContext2D, public color: string) {}

  reset(color: string, fill: string | CanvasPattern | null = null) {
    this.last = null;
    this.color = color;
    this.fill = fill;
  }

  add(x: number, y: number, r: number) {
    const ctx = this.ctx;
    const c = { x, y, r: Math.max(0.35, r) };
    ctx.fillStyle = this.fill ?? this.color;
    const prev = this.last;
    if (prev) {
      const d = Math.hypot(c.x - prev.x, c.y - prev.y);
      if (d > Math.abs(prev.r - c.r) + 1e-3) {
        // Separate fills: in one path the quad and the circle could wind in opposite
        // directions and cancel out under the nonzero rule, leaving gaps.
        const t = tangents(prev, c);
        ctx.beginPath();
        ctx.moveTo(t.l1x, t.l1y);
        ctx.lineTo(t.l2x, t.l2y);
        ctx.lineTo(t.r2x, t.r2y);
        ctx.lineTo(t.r1x, t.r1y);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
    this.last = c;
  }
}

// 関数グラフ: axes, ticks, labels and curves of y = f(x) laid out in page units, ready to
// become ordinary constant-width strokes and text boxes (erasable, lassoable, vector in PDFs).
import { parseExpr, type Fn } from './expr';

export interface GraphSpec {
  exprs: string[];
  xmin: number;
  xmax: number;
  /** Both undefined: fit to the curves. */
  ymin?: number;
  ymax?: number;
  /** Plot width in page units. */
  width: number;
  /** 縦横同じ縮尺. */
  equal: boolean;
  grid: boolean;
  numbers: boolean;
  /** x 軸の目盛りを π 単位にする. */
  piTicks: boolean;
}

export interface GraphLine {
  /** Flat x, y. */
  pts: number[];
  color: string;
  width: number;
}

export interface GraphLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  size: number;
  color: string;
}

export interface Graph {
  w: number;
  h: number;
  lines: GraphLine[];
  labels: GraphLabel[];
  /** Per expression: parse error (null = ok). */
  errors: (string | null)[];
  ymin: number;
  ymax: number;
}

export const CURVE_COLORS = ['#1a1a1a', '#1e4fd8', '#d32f2f', '#2e7d32'];
const AXIS = '#1a1a1a';
const GRID = '#c4c4c4';
const LABEL_SIZE = 10;
const ARROW = 5;
const OVERHANG = 12;
const TICK = 3;

export type Measure = (text: string, size: number) => { w: number; h: number };

/** 1, 2 or 5 × 10^k, giving about `target` steps over `range`. */
export function niceStep(range: number, target = 8): number {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function formatTick(v: number): string {
  const s = parseFloat(v.toPrecision(6)).toString();
  return s.startsWith('-') ? '−' + s.slice(1) : s;
}

/** k·π/d as a math label: π/2, π, 3π/2, −π. */
export function piLabel(k: number, d: number): string {
  const g = gcd(Math.abs(k), d);
  const n = k / g, m = d / g;
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  const num = a === 1 ? 'π' : `${a}π`;
  return sign + (m === 1 ? num : `${num}/${m}`);
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** Fit a y range to the curves: robust to asymptotes (percentiles), 0 included when near. */
export function autoRange(fns: Fn[], xmin: number, xmax: number): [number, number] {
  const ys: number[] = [];
  const n = 400;
  for (const f of fns) {
    for (let i = 0; i <= n; i++) {
      const y = f(xmin + ((xmax - xmin) * i) / n);
      if (Number.isFinite(y)) ys.push(y);
    }
  }
  if (!ys.length) return [-1, 1];
  ys.sort((a, b) => a - b);
  const q = (p: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(p * (ys.length - 1))))];
  let lo = q(0.02), hi = q(0.98);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  if (lo > 0 && lo < (hi - lo) * 0.6) lo = 0;
  if (hi < 0 && -hi < (hi - lo) * 0.6) hi = 0;
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

/** Clip segment a→b to the rectangle (Liang–Barsky). */
function clip(ax: number, ay: number, bx: number, by: number, w: number, h: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [
    [-dx, ax],
    [dx, w - ax],
    [-dy, ay],
    [dy, h - ay],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/** Douglas–Peucker on a flat x,y array. */
function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i * 2] - ax) * dy - (pts[i * 2 + 1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/**
 * Trace y = f(x) into polylines in plot coordinates (0..w, 0..h, y down). Adaptive: segments
 * are split where the curve bends or leaves its domain, broken at asymptotes, clipped to the box.
 */
export function traceCurve(f: Fn, sx: (x: number) => number, sy: (y: number) => number, xmin: number, xmax: number, w: number, h: number): number[][] {
  const BIG = 1e6;
  const Y = (x: number) => {
    const y = f(x);
    return Number.isFinite(y) ? Math.max(-BIG, Math.min(BIG, sy(y))) : NaN;
  };
  const raw: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  const flush = () => {
    if (cur.length > 1) raw.push(cur);
    cur = [];
  };
  /** Last x in [a, b] where f is still defined (a defined, b not), by bisection. */
  const edge = (a: number, b: number) => {
    for (let k = 0; k < 30; k++) {
      const m = (a + b) / 2;
      if (Number.isFinite(Y(m))) a = m;
      else b = m;
    }
    return a;
  };
  const seg = (xa: number, ya: number, xb: number, yb: number, depth: number) => {
    const xm = (xa + xb) / 2;
    const ym = Y(xm);
    const bend = Number.isFinite(ym) ? Math.abs(ym - (ya + yb) / 2) : Infinity;
    const steep = Math.abs(yb - ya);
    if (depth < 10 && (bend > 0.15 || steep > h * 0.25) && sx(xb) - sx(xa) > 0.02) {
      if (!Number.isFinite(ym)) {
        // A hole inside the segment: finish up to it and restart after it.
        const e1 = edge(xa, xm);
        cur.push({ x: sx(e1), y: Y(e1) });
        flush();
        const e2 = edge(xb, xm);
        cur.push({ x: sx(e2), y: Y(e2) }, { x: sx(xb), y: yb });
        return;
      }
      seg(xa, ya, xm, ym, depth + 1);
      seg(xm, ym, xb, yb, depth + 1);
      return;
    }
    // Still a jump across the whole box at the finest step: an asymptote (tan x, 1/x).
    if (steep > h && Math.sign(ya - h / 2) !== Math.sign(yb - h / 2)) {
      flush();
      cur.push({ x: sx(xb), y: yb });
      return;
    }
    cur.push({ x: sx(xb), y: yb });
  };
  const n = 240;
  let px = xmin, py = Y(xmin);
  if (Number.isFinite(py)) cur.push({ x: sx(px), y: py });
  for (let i = 1; i <= n; i++) {
    const x = xmin + ((xmax - xmin) * i) / n;
    const y = Y(x);
    const okA = Number.isFinite(py), okB = Number.isFinite(y);
    if (okA && okB) seg(px, py, x, y, 0);
    else if (okA && !okB) {
      const e = edge(px, x);
      cur.push({ x: sx(e), y: Y(e) });
      flush();
    } else if (!okA && okB) {
      flush();
      const e = edge(x, px);
      cur.push({ x: sx(e), y: Y(e) }, { x: sx(x), y });
    }
    px = x;
    py = y;
  }
  flush();
  // Clip every polyline to the box, splitting where it leaves and re-enters.
  const out: number[][] = [];
  for (const line of raw) {
    let poly: number[] = [];
    for (let i = 1; i < line.length; i++) {
      const c = clip(line[i - 1].x, line[i - 1].y, line[i].x, line[i].y, w, h);
      if (!c) {
        if (poly.length) out.push(poly);
        poly = [];
        continue;
      }
      const n2 = poly.length;
      if (n2 && Math.abs(poly[n2 - 2] - c[0]) < 1e-6 && Math.abs(poly[n2 - 1] - c[1]) < 1e-6) poly.push(c[2], c[3]);
      else {
        if (poly.length) out.push(poly);
        poly = [c[0], c[1], c[2], c[3]];
      }
    }
    if (poly.length) out.push(poly);
  }
  return out.map((p) => simplify(p, 0.06)).filter((p) => p.length >= 4);
}

export function buildGraph(spec: GraphSpec, measure: Measure): Graph {
  const errors: (string | null)[] = [];
  const fns: { f: Fn; i: number }[] = [];
  spec.exprs.forEach((src, i) => {
    try {
      fns.push({ f: parseExpr(src), i });
      errors.push(null);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  });
  const xmin = Math.min(spec.xmin, spec.xmax);
  const xmax = spec.xmax === spec.xmin ? xmin + 1 : Math.max(spec.xmin, spec.xmax);
  let [ymin, ymax] =
    spec.ymin !== undefined && spec.ymax !== undefined && spec.ymin !== spec.ymax
      ? [Math.min(spec.ymin, spec.ymax), Math.max(spec.ymin, spec.ymax)]
      : fns.length
        ? autoRange(
            fns.map((f) => f.f),
            xmin,
            xmax,
          )
        : // 座標軸だけ: the same scale both ways.
          [xmin * 0.72, xmax * 0.72];
  if (!(ymax > ymin)) [ymin, ymax] = [-1, 1];

  let w = spec.width;
  let h = w * 0.72;
  if (spec.equal) {
    h = (w * (ymax - ymin)) / (xmax - xmin);
    const maxH = spec.width * 1.3;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    h = Math.max(h, 8);
  }
  const sx = (x: number) => ((x - xmin) / (xmax - xmin)) * w;
  const sy = (y: number) => ((ymax - y) / (ymax - ymin)) * h;

  const lines: GraphLine[] = [];
  const labels: GraphLabel[] = [];
  const label = (text: string, x: number, y: number, ax: number, ay: number, color = AXIS, size = LABEL_SIZE) => {
    const m = measure(text, size);
    labels.push({ x: x - m.w * ax, y: y - m.h * ay, w: m.w, h: m.h, text, size, color });
  };

  // Axes sit at 0 when it is in range, otherwise on the box edge.
  const ax = ymin <= 0 && ymax >= 0 ? sy(0) : ymin > 0 ? h : 0;
  const ay = xmin <= 0 && xmax >= 0 ? sx(0) : xmin > 0 ? 0 : w;
  const xAtZero = ymin <= 0 && ymax >= 0, yAtZero = xmin <= 0 && xmax >= 0;

  // Ticks.
  const xticks: { v: number; px: number; text: string }[] = [];
  if (spec.piTicks) {
    const d = (xmax - xmin) / (Math.PI / 2) <= 12 ? 2 : (xmax - xmin) / Math.PI <= 12 ? 1 : 0;
    if (d) for (let k = Math.ceil((xmin * d) / Math.PI - 1e-9); k <= Math.floor((xmax * d) / Math.PI + 1e-9); k++) xticks.push({ v: (k * Math.PI) / d, px: sx((k * Math.PI) / d), text: piLabel(k, d) });
  }
  if (!xticks.length) {
    const st = niceStep(xmax - xmin, Math.max(4, Math.round(w / 45)));
    for (let k = Math.ceil(xmin / st - 1e-9); k <= Math.floor(xmax / st + 1e-9); k++) xticks.push({ v: k * st, px: sx(k * st), text: formatTick(k * st) });
  }
  const yst = niceStep(ymax - ymin, Math.max(3, Math.round(h / 40)));
  const yticks: { v: number; py: number; text: string }[] = [];
  for (let k = Math.ceil(ymin / yst - 1e-9); k <= Math.floor(ymax / yst + 1e-9); k++) yticks.push({ v: k * yst, py: sy(k * yst), text: formatTick(k * yst) });

  if (spec.grid) {
    for (const t of xticks) if (Math.abs(t.v) > 1e-12 || !yAtZero) lines.push({ pts: [t.px, 0, t.px, h], color: GRID, width: 0.5 });
    for (const t of yticks) if (Math.abs(t.v) > 1e-12 || !xAtZero) lines.push({ pts: [0, t.py, w, t.py], color: GRID, width: 0.5 });
  }

  // Axes with arrowheads on the positive ends.
  const xEnd = w + OVERHANG, yTop = -OVERHANG;
  lines.push({ pts: [Math.min(0, ay - 4), ax, xEnd, ax], color: AXIS, width: 1 });
  lines.push({ pts: [xEnd - ARROW, ax - ARROW * 0.6, xEnd, ax, xEnd - ARROW, ax + ARROW * 0.6], color: AXIS, width: 1 });
  lines.push({ pts: [ay, Math.max(h, ax + 4), ay, yTop], color: AXIS, width: 1 });
  lines.push({ pts: [ay - ARROW * 0.6, yTop + ARROW, ay, yTop, ay + ARROW * 0.6, yTop + ARROW], color: AXIS, width: 1 });
  label('x', xEnd + 2, ax + 2, 0, 0, AXIS, LABEL_SIZE + 2);
  label('y', ay + 4, yTop - 2, 0, 0.6, AXIS, LABEL_SIZE + 2);
  if (xAtZero && yAtZero) label('O', ay - 2, ax + 2, 1, 0);

  for (const t of xticks) {
    if (xAtZero && yAtZero && Math.abs(t.v) < 1e-12) continue;
    lines.push({ pts: [t.px, ax - TICK, t.px, ax + TICK], color: AXIS, width: 0.8 });
    if (spec.numbers) label(t.text, t.px, ax + TICK + 1.5, 0.5, 0);
  }
  for (const t of yticks) {
    if (xAtZero && yAtZero && Math.abs(t.v) < 1e-12) continue;
    lines.push({ pts: [ay - TICK, t.py, ay + TICK, t.py], color: AXIS, width: 0.8 });
    if (spec.numbers) label(t.text, ay - TICK - 2, t.py, 1, 0.5);
  }

  // Curves, each named at its right end when there are several.
  const named: { x: number; y: number; w: number; h: number }[] = [];
  for (const { f, i } of fns) {
    const color = CURVE_COLORS[i % CURVE_COLORS.length];
    const polys = traceCurve(f, sx, sy, xmin, xmax, w, h);
    for (const p of polys) lines.push({ pts: p, color, width: 1.6 });
    if (fns.length > 1 && polys.length) {
      const last = polys[polys.length - 1];
      const ex = last[last.length - 2], ey = last[last.length - 1];
      const text = 'y=' + spec.exprs[i].replace(/^\s*(y|[a-z]\s*\(\s*x\s*\))\s*=\s*/i, '').trim();
      const m = measure(text, LABEL_SIZE);
      const x = Math.min(ex - 2, w - m.w);
      let y = ey < h / 2 ? ey + 3 : ey - 3 - m.h;
      // Curves often end at the same place: stack the names instead of overprinting.
      const step = ey < h / 2 ? m.h : -m.h;
      while (named.some((r) => x < r.x + r.w && r.x < x + m.w && y < r.y + r.h && r.y < y + m.h)) y += step;
      named.push({ x, y, w: m.w, h: m.h });
      label(text, x, y, 0, 0, color);
    }
  }

  // Move everything so the bounds start at (0, 0).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lines)
    for (let k = 0; k < l.pts.length; k += 2) {
      minX = Math.min(minX, l.pts[k]);
      maxX = Math.max(maxX, l.pts[k]);
      minY = Math.min(minY, l.pts[k + 1]);
      maxY = Math.max(maxY, l.pts[k + 1]);
    }
  for (const b of labels) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  for (const l of lines) for (let k = 0; k < l.pts.length; k += 2) (l.pts[k] -= minX), (l.pts[k + 1] -= minY);
  for (const b of labels) (b.x -= minX), (b.y -= minY);
  return { w: maxX - minX, h: maxY - minY, lines, labels, errors, ymin, ymax };
}

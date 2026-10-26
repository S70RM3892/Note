/**
 * Bitmap → vector outlines.
 *
 * 1. Label 8-connected ink components (drops specks, groups each shape's holes with it).
 * 2. Follow pixel-edge boundaries with the ink on the right: outlines come out clockwise,
 *    holes counter-clockwise, so a nonzero fill reproduces the holes.
 * 3. Simplify the staircase (Ramer–Douglas–Peucker) and fit quadratic curves through it,
 *    keeping sharp turns as corners.
 */

export interface TraceOptions {
  /** Components smaller than this many pixels are dropped. */
  minArea: number;
  /** Simplification tolerance in pixels. */
  tolerance: number;
  /** Turn angle (radians) above which a vertex stays a sharp corner. */
  cornerAngle: number;
  /** Tile size for grouping shapes. */
  tile: number;
  /** Shapes touching the image edge and at most this thick are crop slivers (desk showing at the edge). */
  sliver: number;
}

export const DEFAULT_TRACE: TraceOptions = { minArea: 6, tolerance: 0.75, cornerAngle: 1.05, tile: 256, sliver: 0 };

export interface Components {
  label: Int32Array; // -1 = background
  count: number;
  area: Int32Array;
  bbox: Int32Array; // x0,y0,x1,y1 per component
}

export function labelComponents(mask: Uint8Array, w: number, h: number): Components {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const areas: number[] = [];
  const boxes: number[] = [];
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] !== -1) continue;
    let sp = 0, area = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = i;
    label[i] = count;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && label[q] === -1) {
            label[q] = count;
            stack[sp++] = q;
          }
        }
      }
    }
    areas.push(area);
    boxes.push(x0, y0, x1 + 1, y1 + 1);
    count++;
  }
  return { label, count, area: Int32Array.from(areas), bbox: Int32Array.from(boxes) };
}

export interface Loop {
  comp: number;
  /** Flat corner coordinates of the staircase polygon (vertices at turns). */
  pts: number[];
  area: number; // signed: >0 outline (clockwise on screen), <0 hole
}

/** Trace every boundary of the mask. */
export function traceLoops(mask: Uint8Array, w: number, h: number, comps: Components): Loop[] {
  const W1 = w + 1;
  const visited = new Uint8Array(W1 * (h + 1)); // horizontal edge (x,y)→(x+1,y)
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const loops: Loop[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] || ink(x, y - 1) || visited[y * W1 + x]) continue;
      // Walk with ink on the right. Directions: 0 E, 1 S, 2 W, 3 N.
      let cx = x, cy = y, d = 0;
      const pts: number[] = [cx, cy];
      let area = 0;
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        const px = cx, py = cy;
        if (d === 0) {
          visited[cy * W1 + cx] = 1;
          cx++;
        } else if (d === 2) {
          cx--;
          visited[cy * W1 + cx] = 1;
        } else if (d === 1) cy++;
        else cy--;
        area += px * cy - cx * py;
        let la: boolean, ra: boolean;
        if (d === 0) {
          la = ink(cx, cy - 1);
          ra = ink(cx, cy);
        } else if (d === 1) {
          la = ink(cx, cy);
          ra = ink(cx - 1, cy);
        } else if (d === 2) {
          la = ink(cx - 1, cy);
          ra = ink(cx - 1, cy - 1);
        } else {
          la = ink(cx - 1, cy - 1);
          ra = ink(cx, cy - 1);
        }
        // Ink ahead-left: turn left (8-connected ink); ink ahead-right only: straight; else right.
        const nd = la ? (d + 3) & 3 : ra ? d : (d + 1) & 3;
        if (cx === x && cy === y && nd === 0) break;
        if (nd !== d) pts.push(cx, cy);
        d = nd;
      }
      loops.push({ comp: comps.label[y * w + x], pts, area: area / 2 });
    }
  }
  return loops;
}

// ---------- simplification & curve fitting ----------

function perp(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(dy * px - dx * py + bx * ay - by * ax) / L;
}

function rdpRange(pts: number[], s: number, e: number, eps: number, keep: Uint8Array) {
  const stack: [number, number][] = [[s, e]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perp(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
}

/** RDP on a closed polygon (flat coords, no repeated closing point). */
export function simplifyClosed(pts: number[], eps: number): number[] {
  const n = pts.length / 2;
  if (n <= 4) return pts.slice();
  // Split at vertex 0 and the vertex farthest from it.
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const ext = pts.concat([pts[0], pts[1]]);
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  rdpRange(ext, 0, far, eps, keep);
  rdpRange(ext, far, n, eps, keep);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** SVG path of a closed polygon with smooth curves except at sharp corners. */
export function smoothPath(p: number[], cornerAngle: number): string {
  const n = p.length / 2;
  if (n < 3) return '';
  const X = (i: number) => p[((i + n) % n) * 2], Y = (i: number) => p[((i + n) % n) * 2 + 1];
  const mid = (i: number) => [(X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2];
  const corner = (i: number) => {
    const ax = X(i) - X(i - 1), ay = Y(i) - Y(i - 1), bx = X(i + 1) - X(i), by = Y(i + 1) - Y(i);
    const t = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    return t > cornerAngle;
  };
  const m0 = mid(-1);
  let d = `M${f1(m0[0])} ${f1(m0[1])}`;
  for (let i = 0; i < n; i++) {
    const m = mid(i);
    if (corner(i)) d += `L${f1(X(i))} ${f1(Y(i))}L${f1(m[0])} ${f1(m[1])}`;
    else d += `Q${f1(X(i))} ${f1(Y(i))} ${f1(m[0])} ${f1(m[1])}`;
  }
  return d + 'Z';
}

export interface TracedTile {
  b: [number, number, number, number];
  d: string;
}

/** Vectorize one ink mask into tiles of path data. */
export function vectorizeMask(mask: Uint8Array, w: number, h: number, opt: TraceOptions = DEFAULT_TRACE): { tiles: TracedTile[]; shapes: number } {
  const comps = labelComponents(mask, w, h);
  const loops = traceLoops(mask, w, h, comps);
  const tiles = new Map<string, { b: [number, number, number, number]; parts: string[] }>();
  let shapes = 0;
  const kept = new Uint8Array(comps.count);
  for (let c = 0; c < comps.count; c++) {
    if (comps.area[c] < opt.minArea) continue;
    const x0 = comps.bbox[c * 4], y0 = comps.bbox[c * 4 + 1], x1 = comps.bbox[c * 4 + 2], y1 = comps.bbox[c * 4 + 3];
    const atEdge = x0 === 0 || y0 === 0 || x1 === w || y1 === h;
    if (opt.sliver && atEdge && Math.min(x1 - x0, y1 - y0) <= opt.sliver) continue;
    kept[c] = 1;
  }
  for (const loop of loops) {
    if (loop.comp < 0 || !kept[loop.comp]) continue;
    if (loop.area < 0 && -loop.area < Math.max(2, opt.minArea / 2)) continue; // pin-holes
    const simple = simplifyClosed(loop.pts, opt.tolerance);
    const d = smoothPath(simple, opt.cornerAngle);
    if (!d) continue;
    const c = loop.comp;
    const bx0 = comps.bbox[c * 4], by0 = comps.bbox[c * 4 + 1], bx1 = comps.bbox[c * 4 + 2], by1 = comps.bbox[c * 4 + 3];
    const key = `${Math.floor((bx0 + bx1) / 2 / opt.tile)},${Math.floor((by0 + by1) / 2 / opt.tile)}`;
    let t = tiles.get(key);
    if (!t) {
      t = { b: [bx0, by0, bx1, by1], parts: [] };
      tiles.set(key, t);
    } else {
      t.b = [Math.min(t.b[0], bx0), Math.min(t.b[1], by0), Math.max(t.b[2], bx1), Math.max(t.b[3], by1)];
    }
    t.parts.push(d);
    if (loop.area > 0) shapes++;
  }
  return { tiles: [...tiles.values()].map((t) => ({ b: t.b, d: t.parts.join('') })), shapes };
}

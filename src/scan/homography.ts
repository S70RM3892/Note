import type { RGBA } from './raster';

export interface P2 {
  x: number;
  y: number;
}

/** 3x3 homography (row-major, h[8] = 1) mapping src[i] → dst[i]. */
export function homography(src: P2[], dst: P2[]): number[] {
  // Solve the 8x8 system A h = b.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const p = M[c][c];
    if (Math.abs(p) < 1e-12) throw new Error('degenerate quadrilateral');
    for (let k = c; k <= n; k++) M[c][k] /= p;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

export function applyH(h: number[], x: number, y: number): P2 {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function dist(a: P2, b: P2) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Output size for a quad (TL, TR, BR, BL) keeping its apparent aspect, long side = `long`. */
export function outputSize(quad: P2[], long: number): { w: number; h: number } {
  const wTop = dist(quad[0], quad[1]), wBot = dist(quad[3], quad[2]);
  const hL = dist(quad[0], quad[3]), hR = dist(quad[1], quad[2]);
  const aw = (wTop + wBot) / 2, ah = (hL + hR) / 2;
  const k = long / Math.max(aw, ah, 1);
  return { w: Math.max(8, Math.round(aw * k)), h: Math.max(8, Math.round(ah * k)) };
}

/** Perspective-correct the quad (TL, TR, BR, BL) of `src` into a w×h image (bilinear). */
export function warp(src: RGBA, quad: P2[], w: number, h: number): RGBA {
  // Map output pixels back into the source.
  const H = homography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    quad,
  );
  const out = new Uint8ClampedArray(w * h * 4);
  const sd = src.data, sw = src.w, sh = src.h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const ww = H[6] * X + H[7] * Y + H[8];
      let fx = (H[0] * X + H[1] * Y + H[2]) / ww - 0.5;
      let fy = (H[3] * X + H[4] * Y + H[5]) / ww - 0.5;
      fx = Math.min(sw - 1.001, Math.max(0, fx));
      fy = Math.min(sh - 1.001, Math.max(0, fy));
      const x0 = fx | 0, y0 = fy | 0;
      const tx = fx - x0, ty = fy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * tx;
        const b = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * tx;
        out[o + c] = a + (b - a) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

/** Rotate an RGBA image by 90° clockwise. */
export function rotate90(src: RGBA): RGBA {
  const { w, h, data } = src;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = h - 1 - y, ny = x;
      const o = (ny * h + nx) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  }
  return { w: h, h: w, data: out };
}

/** Minimal raster types/helpers for the scan pipeline (runs in a worker and in tests). */

export interface RGBA {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA
}

export interface Gray {
  w: number;
  h: number;
  data: Uint8Array;
}

export function toGray(img: RGBA): Gray {
  const n = img.w * img.h;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return { w: img.w, h: img.h, data: out };
}

/** Area-average downscale by an integer factor. */
export function downscaleGray(g: Gray, f: number): Gray {
  const w = Math.max(1, Math.floor(g.w / f)), h = Math.max(1, Math.floor(g.h / f));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * g.w + x * f;
        for (let xx = 0; xx < f; xx++) s += g.data[row + xx];
      }
      out[y * w + x] = s / (f * f);
    }
  }
  return { w, h, data: out };
}

/** Separable box blur with clamped edges (in place-safe: returns a new array). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / k;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Bilinear sample of a small float grid at fractional coordinates. */
export function sampleGrid(grid: Float32Array, gw: number, gh: number, fx: number, fy: number): number {
  const x = Math.min(gw - 1, Math.max(0, fx)), y = Math.min(gh - 1, Math.max(0, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = grid[y0 * gw + x0], b = grid[y0 * gw + x1], c = grid[y1 * gw + x0], d = grid[y1 * gw + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Otsu threshold of a gray image. */
export function otsu(g: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const total = g.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

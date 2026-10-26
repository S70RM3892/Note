import { boxBlur, sampleGrid, type RGBA } from './raster';

/**
 * Paper colour estimated on a coarse grid: per cell, the mean colour of its brightest
 * pixels. Cells with no paper in them at all (inside a large filled shape) are recognised
 * by being far darker or differently coloured than the brightest cell around them and are
 * filled in from their paper neighbours; the grid is then dilated and blurred. Dividing by
 * it removes shadows, uneven lighting and colour casts without bleaching big solid ink.
 */
export interface Background {
  gw: number;
  gh: number;
  cell: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export function estimateBackground(img: RGBA, cell = Math.max(12, Math.round(Math.max(img.w, img.h) / 90))): Background {
  const gw = Math.ceil(img.w / cell), gh = Math.ceil(img.h / cell);
  const R = new Float32Array(gw * gh), G = new Float32Array(gw * gh), B = new Float32Array(gw * gh);
  const d = img.data;
  const hist = new Uint32Array(64);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      hist.fill(0);
      const x0 = cx * cell, y0 = cy * cell, x1 = Math.min(img.w, x0 + cell), y1 = Math.min(img.h, y0 + cell);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.w + x) * 4;
          hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 10]++;
          n++;
        }
      }
      // Threshold at the brightest 25 %.
      let acc = 0, t = 63;
      while (t > 0 && acc + hist[t] < n * 0.25) acc += hist[t--];
      let sr = 0, sg = 0, sb = 0, m = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.w + x) * 4;
          if ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 10 >= t) {
            sr += d[i];
            sg += d[i + 1];
            sb += d[i + 2];
            m++;
          }
        }
      }
      const k = cy * gw + cx;
      R[k] = m ? sr / m : 255;
      G[k] = m ? sg / m : 255;
      B[k] = m ? sb / m : 255;
    }
  }
  fillInkCells(R, G, B, gw, gh, Math.max(6, Math.round(Math.max(gw, gh) / 4)));
  const dilate = (src: Float32Array) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let mx = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) mx = Math.max(mx, src[yy * gw + xx]);
        out[y * gw + x] = mx;
      }
    }
    return out;
  };
  const smooth = (a: Float32Array) => boxBlur(dilate(a), gw, gh, 1);
  return { gw, gh, cell, r: smooth(R), g: smooth(G), b: smooth(B) };
}

/**
 * Mark cells whose "paper" is really ink — luminance below 45 % of the brightest cell within
 * `radius` cells (soft and hard shadows stay above that), or a clearly different chromaticity —
 * and replace them by growing the surrounding paper colour inwards, ring by ring.
 */
function fillInkCells(R: Float32Array, G: Float32Array, B: Float32Array, gw: number, gh: number, radius: number) {
  const n = gw * gh;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.3 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  // Argmax of luminance in a (2r+1)² window, separably (rows, then columns).
  const rowBest = new Int32Array(n), best = new Int32Array(n);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let b = y * gw + x;
      for (let xx = Math.max(0, x - radius); xx <= Math.min(gw - 1, x + radius); xx++) if (lum[y * gw + xx] > lum[b]) b = y * gw + xx;
      rowBest[y * gw + x] = b;
    }
  }
  for (let x = 0; x < gw; x++) {
    for (let y = 0; y < gh; y++) {
      let b = rowBest[y * gw + x];
      for (let yy = Math.max(0, y - radius); yy <= Math.min(gh - 1, y + radius); yy++) {
        const c = rowBest[yy * gw + x];
        if (lum[c] > lum[b]) b = c;
      }
      best[y * gw + x] = b;
    }
  }
  const valid = new Uint8Array(n);
  let anyValid = false;
  for (let i = 0; i < n; i++) {
    const r = best[i];
    const L = Math.max(1, lum[i]), Lr = Math.max(1, lum[r]);
    const chroma = Math.abs(R[i] / L - R[r] / Lr) + Math.abs(G[i] / L - G[r] / Lr) + Math.abs(B[i] / L - B[r] / Lr);
    if (lum[i] >= 0.45 * Lr && chroma < 0.3) {
      valid[i] = 1;
      anyValid = true;
    }
  }
  if (!anyValid) return;
  let pending = n;
  for (let i = 0; i < n; i++) pending -= valid[i];
  const next: number[] = [];
  while (pending > 0) {
    next.length = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (valid[i]) continue;
        let sr = 0, sg = 0, sb = 0, m = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) {
            const j = yy * gw + xx;
            if (!valid[j]) continue;
            sr += R[j];
            sg += G[j];
            sb += B[j];
            m++;
          }
        }
        if (!m) continue;
        R[i] = sr / m;
        G[i] = sg / m;
        B[i] = sb / m;
        next.push(i);
      }
    }
    if (!next.length) break;
    for (const i of next) valid[i] = 1; // usable from the next ring on
    pending -= next.length;
  }
}

/** Per-pixel normalised colour measures (0..255): darkness by luminance, darkness by the darkest channel, chroma, hue. */
export interface InkMaps {
  w: number;
  h: number;
  dark: Uint8Array; // 1 - luminance (mono ink)
  darkAny: Uint8Array; // 1 - min channel (catches light coloured ink)
  chroma: Uint8Array;
  hue: Uint8Array; // 0..255 ≙ 0..360°
  /** Background-normalised colour image (the cleaned-up "photo"). */
  clean: Uint8ClampedArray;
}

export function inkMaps(img: RGBA, bg: Background): InkMaps {
  const { w, h, data } = img;
  const n = w * h;
  const dark = new Uint8Array(n), darkAny = new Uint8Array(n), chroma = new Uint8Array(n), hue = new Uint8Array(n);
  const clean = new Uint8ClampedArray(n * 4);
  const inv = 1 / bg.cell;
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) * inv - 0.5;
      const i = y * w + x, o = i * 4;
      const br = Math.max(24, sampleGrid(bg.r, bg.gw, bg.gh, gx, gy));
      const bgg = Math.max(24, sampleGrid(bg.g, bg.gw, bg.gh, gx, gy));
      const bb = Math.max(24, sampleGrid(bg.b, bg.gw, bg.gh, gx, gy));
      const r = Math.min(1, data[o] / br), g = Math.min(1, data[o + 1] / bgg), b = Math.min(1, data[o + 2] / bb);
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      dark[i] = (1 - L) * 255;
      darkAny[i] = (1 - mn) * 255;
      const c = mx - mn;
      chroma[i] = c * 255;
      if (c > 0.02) {
        let hh: number;
        if (mx === r) hh = ((g - b) / c) % 6;
        else if (mx === g) hh = (b - r) / c + 2;
        else hh = (r - g) / c + 4;
        hue[i] = (((hh * 60 + 360) % 360) / 360) * 255;
      }
      // Clean photo: paper → white, gentle contrast on the ink.
      clean[o] = 255 * (1 - Math.min(1, (1 - r) * 1.12));
      clean[o + 1] = 255 * (1 - Math.min(1, (1 - g) * 1.12));
      clean[o + 2] = 255 * (1 - Math.min(1, (1 - b) * 1.12));
      clean[o + 3] = 255;
    }
  }
  return { w, h, dark, darkAny, chroma, hue, clean };
}

/**
 * Hysteresis threshold: pixels darker than `strong` seed the ink, which then grows into
 * 8-connected pixels darker than `weak` (keeps faint pencil attached to its stroke,
 * drops isolated paper grain).
 */
export function hysteresis(dark: Uint8Array, w: number, h: number, strong: number, weak: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < w * h; i++) {
    if (dark[i] >= strong) {
      mask[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp) {
    const p = stack[--sp];
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!mask[q] && dark[q] >= weak) {
          mask[q] = 1;
          stack[sp++] = q;
        }
      }
    }
  }
  return mask;
}

export interface InkLayer {
  color: string;
  mask: Uint8Array;
}

function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** Thresholds for a sensitivity of 0 (only bold ink) … 1 (picks up faint pencil). */
export function thresholds(sensitivity: number): { strong: number; weak: number } {
  const s = Math.min(1, Math.max(0, sensitivity));
  const strong = (0.54 - 0.24 * s) * 255;
  return { strong, weak: strong * 0.45 };
}

/**
 * Split ink into layers. 'mono' → one black layer. 'color' → near-neutral ink as black
 * plus up to three colour layers found from the hue histogram of the coloured ink.
 */
export function splitLayers(maps: InkMaps, mode: 'mono' | 'color', sensitivity: number): InkLayer[] {
  const { w, h } = maps;
  const { strong, weak } = thresholds(sensitivity);
  if (mode === 'mono') return [{ color: '#141414', mask: hysteresis(maps.dark, w, h, strong, weak) }];

  const ink = hysteresis(maps.darkAny, w, h, strong, weak);
  const n = w * h;
  const CH = 0.2 * 255;
  const bins = new Float64Array(24);
  let colored = 0;
  for (let i = 0; i < n; i++) {
    if (ink[i] && maps.chroma[i] >= CH) {
      bins[Math.floor((maps.hue[i] / 256) * 24)] += 1;
      colored++;
    }
  }
  // Peaks of the (circular) hue histogram.
  const peaks: { bin: number; mass: number }[] = [];
  for (let b = 0; b < 24; b++) {
    const v = bins[b], l = bins[(b + 23) % 24], r = bins[(b + 1) % 24];
    if (v > 0 && v >= l && v >= r) peaks.push({ bin: b, mass: v + l + r });
  }
  peaks.sort((a, b) => b.mass - a.mass);
  const kept = peaks.filter((p) => p.mass >= colored * 0.04 && p.mass >= 40).slice(0, 3);
  const black = new Uint8Array(n);
  const masks = kept.map(() => new Uint8Array(n));
  const sums = kept.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    if (!ink[i]) continue;
    if (maps.chroma[i] < CH || !kept.length) {
      // Light-but-neutral pixels (e.g. grey paper texture caught by darkAny) only count if dark.
      if (maps.dark[i] >= weak) black[i] = 1;
      continue;
    }
    const hb = (maps.hue[i] / 256) * 24;
    let best = 0, bd = Infinity;
    kept.forEach((p, k) => {
      const dd = Math.min(Math.abs(hb - (p.bin + 0.5)), 24 - Math.abs(hb - (p.bin + 0.5)));
      if (dd < bd) {
        bd = dd;
        best = k;
      }
    });
    masks[best][i] = 1;
    // Colour from the core of the ink only: anti-aliased edges are paler.
    const core = maps.darkAny[i] >= strong ? 1 : 0;
    const o = i * 4;
    const s = sums[best];
    s[0] += maps.clean[o] * core;
    s[1] += maps.clean[o + 1] * core;
    s[2] += maps.clean[o + 2] * core;
    s[3] += core;
  }
  const layers: InkLayer[] = kept.map((_, k) => {
    const s = sums[k];
    const m = Math.max(1, s[3]);
    return { color: hex((s[0] / m) * 0.95, (s[1] / m) * 0.95, (s[2] / m) * 0.95), mask: masks[k] };
  });
  // Colour layers underneath, black on top (text over highlighter stays crisp).
  return [...layers, { color: '#141414', mask: black }];
}
